import { buildCodexDeliveryPrompt } from '../codex/prompt.js';
import type { CodexClient } from '../codex/client.js';
import { FakeCodexClient } from '../codex/client.js';
import { SdkCodexClient } from '../codex/sdkClient.js';
import { AppServerCodexClient } from '../codex/appServerClient.js';
import { deliveryErrorShape, DeliveryTransportError, type CodexDeliveryInput, type CodexDeliveryResult, type DeliveryOutboxRow, type HermesDeliveryPayload, type HermesDeliveryResult } from './types.js';
import type { DeliveryAdapter, DeliveryMode } from '../schemas.js';
import { PlanReviewStore, type StoredEvent } from '../storage/database.js';
import { PlanReviewError } from '../util.js';

const DELIVERY_LEASE_SECONDS = 1800;

interface HermesClient {
  deliverComment(input: { target: { threadId?: string }; payload: HermesDeliveryPayload }): Promise<HermesDeliveryResult>;
}

class FakeHermesClient implements HermesClient {
  async deliverComment(input: { target: { threadId?: string }; payload: HermesDeliveryPayload }): Promise<HermesDeliveryResult> {
    return {
      replyBody: `Hermes fake response for ${input.payload.commentId}.`,
      finalResponse: `Hermes fake response for ${input.payload.commentId}.`,
      threadId: input.target.threadId ?? 'fake-hermes',
      changedFiles: input.payload.sourcePath ? [input.payload.sourcePath] : undefined
    };
  }
}

class WebhookHermesClient implements HermesClient {
  async deliverComment(input: { target: { threadId?: string }; payload: HermesDeliveryPayload }): Promise<HermesDeliveryResult> {
    const url = input.target.threadId;
    if (!url) throw new DeliveryTransportError('hermes_webhook_missing_url', 'Hermes webhook mode requires threadId to contain the local webhook URL', false);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.payload)
    });
    if (!response.ok) {
      throw new DeliveryTransportError('hermes_webhook_failed', `Hermes webhook returned HTTP ${response.status}`, response.status >= 500 || response.status === 429);
    }
    const json = await response.json().catch(() => ({})) as HermesDeliveryResult;
    return json;
  }
}

function deliveryAgentId(adapter: DeliveryAdapter): string {
  return `plan-review-delivery:${adapter}`;
}

export interface DeliveryWorkerOptions {
  enabled?: boolean;
  serviceUrl: string;
  intervalMs?: number;
  maxAttempts?: number;
  claimingTimeoutMs?: number;
  deliveringTimeoutMs?: number;
  ackPendingTimeoutMs?: number;
  clientFactory?: (mode: DeliveryMode) => CodexClient;
  eventBus?: { emitEvent(event: StoredEvent): void };
}

export class DeliveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlightThreads = new Set<string>();
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly claimingTimeoutMs: number;
  private readonly deliveringTimeoutMs: number;
  private readonly ackPendingTimeoutMs: number;

  constructor(private store: PlanReviewStore, private options: DeliveryWorkerOptions) {
    this.enabled = options.enabled ?? false;
    this.intervalMs = options.intervalMs ?? 10000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.claimingTimeoutMs = options.claimingTimeoutMs ?? 60000;
    this.deliveringTimeoutMs = options.deliveringTimeoutMs ?? 30 * 60 * 1000;
    this.ackPendingTimeoutMs = options.ackPendingTimeoutMs ?? 60000;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.wake();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  wake(): void {
    if (!this.enabled) return;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.processOnce().finally(() => this.scheduleNext());
      }, 0);
    }
  }

  private scheduleNext(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.processOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
  }

  async processOnce(): Promise<DeliveryOutboxRow | null> {
    if (!this.enabled || this.running) return null;
    this.running = true;
    try {
      await this.recoverStaleRows();
      const ackPending = this.store.acquireAckPendingDeliveryRow();
      if (ackPending) {
        await this.ackCompletedRow(ackPending);
        return this.store.getDeliveryRow(ackPending.id);
      }
      const row = this.store.acquireNextDeliveryRow();
      if (!row) return null;
      await this.processRow(row);
      return this.store.getDeliveryRow(row.id);
    } finally {
      this.running = false;
    }
  }

  async recoverStaleRows(): Promise<void> {
    const now = Date.now();
    for (const row of this.store.listStaleDeliveryRows(['claiming'], new Date(now - this.claimingTimeoutMs).toISOString())) {
      this.store.markDeliveryStatus(row.id, 'pending', { claimId: null, nextAttemptAt: new Date().toISOString() });
    }
    for (const row of this.store.listStaleDeliveryRows(['delivering'], new Date(now - this.deliveringTimeoutMs).toISOString())) {
      if (row.result || row.adapterTurnId) {
        this.store.markDeliveryStatus(row.id, 'ack_pending');
        continue;
      }
      await this.releaseClaimIfActive(row, 'stale_delivery_recovery');
      if (this.markExternallyHandled(row, { retryUnavailable: false })) continue;
      this.store.markDeliveryStatus(row.id, 'retry_wait', {
        error: { code: 'stale_delivery_recovered', message: 'Stale delivery row recovered before Codex result was stored', retryable: true },
        nextAttemptAt: this.nextAttemptAt(row),
        incrementAttempt: true
      });
    }
    for (const row of this.store.listStaleDeliveryRows(['ack_pending'], new Date(now - this.ackPendingTimeoutMs).toISOString())) {
      if (row.claimId && this.store.activeClaim(row.claimId, row.commentId)) {
        await this.ackCompletedRow(row);
      } else {
        this.store.markDeliveryStatus(row.id, 'ack_failed', {
          error: { code: 'ack_claim_lost', message: 'Codex completed but the queue claim expired or was lost before ack', retryable: false }
        });
      }
    }
  }

  private codexClientFor(mode: DeliveryMode): CodexClient {
    if (this.options.clientFactory) return this.options.clientFactory(mode);
    if (mode === 'fake') return new FakeCodexClient();
    if (mode === 'app-server') return new AppServerCodexClient();
    return new SdkCodexClient();
  }

  private hermesClientFor(mode: DeliveryMode): HermesClient {
    if (mode === 'fake') return new FakeHermesClient();
    if (mode === 'webhook') return new WebhookHermesClient();
    throw new DeliveryTransportError('hermes_mode_invalid', 'Hermes delivery mode must be fake or webhook', false);
  }

  private async processRow(row: DeliveryOutboxRow): Promise<void> {
    const target = this.store.getDeliveryTarget(row.planId, row.adapter);
    if (!target?.enabled || !target.threadId) {
      this.store.markDeliveryStatus(row.id, 'paused', {
        error: { code: 'delivery_disabled', message: 'Delivery target is disabled or missing threadId', retryable: false }
      });
      return;
    }
    if (this.inFlightThreads.has(target.threadId)) {
      this.store.markDeliveryStatus(row.id, 'retry_wait', {
        nextAttemptAt: new Date(Date.now() + 1000).toISOString(),
        error: { code: 'thread_busy', message: 'Another delivery is already in flight for this Codex thread', retryable: true }
      });
      return;
    }

    let claimId: string | undefined;
    try {
      let claimed: ReturnType<PlanReviewStore['claimComments']>;
      try {
        claimed = this.store.claimComments(
          row.planId,
          { mode: 'selected', commentIds: [row.commentId], leaseSeconds: DELIVERY_LEASE_SECONDS },
          deliveryAgentId(row.adapter)
        );
      } catch (error) {
        if (error instanceof PlanReviewError && (error.code === 'claim_conflict' || error.code === 'invalid_state' || error.code === 'not_found')) {
          this.markExternallyHandled(row);
          return;
        }
        throw error;
      }
      this.emitEvents(claimed.events);
      const comment = claimed.claimed[0];
      if (!comment?.claim?.id) {
        this.markExternallyHandled(row);
        return;
      }
      claimId = comment.claim.id;
      this.store.markDeliveryStatus(row.id, 'delivering', { claimId, targetThreadId: target.threadId });
      this.inFlightThreads.add(target.threadId);
      if (row.adapter === 'hermes') {
        const plan = this.store.getPlan(row.planId).plan;
        const payload: HermesDeliveryPayload = {
          planId: row.planId,
          commentId: comment.id,
          claimId,
          reviewMode: plan.reviewMode,
          sourcePath: plan.sourcePath,
          planPath: plan.planPath,
          anchor: comment.anchor,
          context: {
            body: comment.body,
            anchorType: comment.anchorType,
            anchorState: comment.anchorState,
            conversationPayload: comment.conversationPayload
          },
          screenshot: comment.screenshotAssetId ? { assetId: comment.screenshotAssetId, url: `${this.options.serviceUrl}/comment-assets/${comment.screenshotAssetId}` } : undefined,
          threadHistory: comment.threadEntries
        };
        const result = await this.hermesClientFor(target.mode).deliverComment({ target, payload });
        if (result.replyBody) {
          const reply = this.store.appendThreadEntry(comment.id, {
            role: 'agent',
            body: result.replyBody,
            claimId,
            deliveryAdapter: 'hermes',
            createdBy: { displayName: 'Hermes' },
            action: { turnId: result.turnId, changedFiles: result.changedFiles }
          });
          this.options.eventBus?.emitEvent(reply.event);
        }
        this.store.markDeliveryStatus(row.id, 'ack_pending', {
          adapterTurnId: result.turnId ?? null,
          result: this.resultJson({ finalResponse: result.finalResponse ?? result.replyBody ?? 'Hermes delivery completed.', threadId: result.threadId ?? target.threadId ?? 'hermes', turnId: result.turnId, raw: result.raw, fullyResolved: result.fullyResolved, changedFiles: result.changedFiles }),
          error: null
        });
        await this.ackCompletedRow(this.store.getDeliveryRow(row.id)!);
      } else {
        const prompt = buildCodexDeliveryPrompt({
          planId: row.planId,
          reviewUrl: String(comment.conversationPayload?.evidence && typeof comment.conversationPayload.evidence === 'object'
            ? (comment.conversationPayload.evidence as Record<string, unknown>).reviewUrl ?? `/p/${row.planId}`
            : `/p/${row.planId}`),
          serviceUrl: this.options.serviceUrl,
          comment,
          claimId
        });
        const input: CodexDeliveryInput = { target, comment, claimId, prompt };
        const result = await this.codexClientFor(target.mode).deliverComment(input);
        this.store.markDeliveryStatus(row.id, 'ack_pending', {
          adapterTurnId: result.turnId ?? null,
          result: this.resultJson(result),
          error: null
        });
        await this.ackCompletedRow(this.store.getDeliveryRow(row.id)!);
        const ackedRow = this.store.getDeliveryRow(row.id)!;
        if (ackedRow.status === 'delivered' && target.autoResolve && result.fullyResolved) {
          const latest = this.store.getDeliveryRow(row.id)!;
          const resolved = this.store.resolveComment(row.commentId, {
            resolutionNote: 'Codex delivery response indicated the feedback was fully resolved.',
            action: {
              runId: result.turnId,
              responseSummary: result.finalResponse,
              changedFiles: result.changedFiles
            }
          });
          if (resolved.event) this.options.eventBus?.emitEvent(resolved.event);
          this.store.markDeliveryStatus(latest.id, 'resolved');
        }
      }
    } catch (error) {
      const shape = deliveryErrorShape(error);
      if (claimId && shape.retryable) {
        await this.releaseClaimIfActive({ ...row, claimId }, shape.code);
      } else if (claimId && !shape.retryable) {
        await this.releaseClaimIfActive({ ...row, claimId }, shape.code);
      }
      const nextStatus = shape.retryable && row.attemptCount + 1 < this.maxAttempts ? 'retry_wait' : 'failed';
      this.store.markDeliveryStatus(row.id, nextStatus, {
        error: { ...shape, retryable: nextStatus === 'retry_wait' },
        nextAttemptAt: nextStatus === 'retry_wait' ? this.nextAttemptAt(row) : undefined,
        incrementAttempt: true
      });
    } finally {
      if (target?.threadId) this.inFlightThreads.delete(target.threadId);
    }
  }

  private markExternallyHandled(row: DeliveryOutboxRow, options: { retryUnavailable?: boolean } = {}): boolean {
    const retryUnavailable = options.retryUnavailable ?? true;
    try {
      const comment = this.store.getComment(row.commentId);
      if (comment.deletedAt) {
        this.store.markDeliveryStatus(row.id, 'externally_deleted');
        return true;
      } else if (comment.status === 'claimed') {
        this.store.markDeliveryStatus(row.id, 'externally_claimed', { claimId: comment.claim?.id ?? null });
        return true;
      } else if (comment.status === 'acknowledged') {
        this.store.markDeliveryStatus(row.id, 'externally_acknowledged');
        return true;
      } else if (comment.status === 'resolved') {
        this.store.markDeliveryStatus(row.id, 'externally_resolved');
        return true;
      } else if (retryUnavailable) {
        this.store.markDeliveryStatus(row.id, 'retry_wait', {
          nextAttemptAt: new Date(Date.now() + 1000).toISOString(),
          error: { code: 'claim_unavailable', message: 'Comment was not claimable for delivery', retryable: true }
        });
      }
      return false;
    } catch (error) {
      if (error instanceof PlanReviewError && error.code === 'not_found') {
        this.store.markDeliveryStatus(row.id, 'externally_deleted');
        return true;
      }
      throw error;
    }
  }

  private async ackCompletedRow(row: DeliveryOutboxRow): Promise<void> {
    if (!row.claimId) {
      this.store.markDeliveryStatus(row.id, 'ack_failed', {
        error: { code: 'missing_claim', message: 'Delivery row has no claim id to ack', retryable: false }
      });
      return;
    }
    if (!this.store.activeClaim(row.claimId, row.commentId)) {
      if (this.markExternallyHandled(row, { retryUnavailable: false })) return;
      this.store.markDeliveryStatus(row.id, 'ack_failed', {
        error: { code: 'ack_claim_lost', message: 'Codex completed but the queue claim expired or was lost before ack', retryable: false }
      });
      return;
    }
    const result = row.result ?? {};
    const finalResponse = typeof result.finalResponse === 'string' ? result.finalResponse : 'Codex delivery completed.';
    const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles.filter(item => typeof item === 'string') as string[] : undefined;
    try {
      const acked = this.store.ackComment(row.commentId, {
        claimId: row.claimId,
        action: {
          runId: row.adapterTurnId,
          responseSummary: finalResponse,
          changedFiles
        }
      });
      this.emitEvents(acked.expiredEvents);
      if ('event' in acked && acked.event) this.options.eventBus?.emitEvent(acked.event);
      this.store.markDeliveryStatus(row.id, 'delivered');
    } catch (error) {
      if (error instanceof PlanReviewError && (error.code === 'claim_required' || error.code === 'invalid_state')) {
        if (!this.markExternallyHandled(row, { retryUnavailable: false })) {
          this.store.markDeliveryStatus(row.id, 'ack_failed', {
            error: { code: 'ack_failed', message: error.message, retryable: false }
          });
        }
        return;
      }
      throw error;
    }
  }

  private async releaseClaimIfActive(row: Pick<DeliveryOutboxRow, 'commentId' | 'claimId'>, reason: string): Promise<void> {
    if (!row.claimId || !this.store.activeClaim(row.claimId, row.commentId)) return;
    try {
      const released = this.store.releaseComment(row.commentId, row.claimId, reason);
      this.options.eventBus?.emitEvent(released.event);
    } catch {}
  }

  private emitEvents(events: StoredEvent[] | undefined): void {
    for (const event of events ?? []) this.options.eventBus?.emitEvent(event);
  }

  private nextAttemptAt(row: DeliveryOutboxRow): string {
    const delay = Math.min(5 * 60 * 1000, 1000 * 2 ** Math.max(0, row.attemptCount));
    return new Date(Date.now() + delay + Math.floor(Math.random() * 1000)).toISOString();
  }

  private resultJson(result: CodexDeliveryResult): Record<string, unknown> {
    return {
      finalResponse: result.finalResponse,
      threadId: result.threadId,
      turnId: result.turnId,
      raw: result.raw,
      fullyResolved: result.fullyResolved,
      changedFiles: result.changedFiles
    };
  }
}
