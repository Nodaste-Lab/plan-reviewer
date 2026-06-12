import type { CodexClient } from './client.js';
import { DeliveryTransportError, type CodexDeliveryInput, type CodexDeliveryResult } from '../delivery/types.js';
import { buildSdkRunOptions, codexAuthConfigError } from './config.js';

type CodexSdkModule = {
  resumeThread?: (threadId: string, options?: Record<string, unknown>) => Promise<unknown>;
  Codex?: new (options?: Record<string, unknown>) => { resumeThread?: (threadId: string, options?: Record<string, unknown>) => Promise<unknown> };
};

function normalizeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (['low', 'medium', 'high', 'xhigh'].includes(value)) return value;
  throw new DeliveryTransportError(
    'unsupported_effort',
    `Unsupported Codex effort '${value}'`,
    false,
    'Retry with one of: low, medium, high, xhigh.'
  );
}

function observedThreadId(thread: unknown): string | undefined {
  if (!thread || typeof thread !== 'object') return undefined;
  const record = thread as Record<string, unknown>;
  return typeof record.id === 'string'
    ? record.id
    : typeof record.threadId === 'string'
      ? record.threadId
      : undefined;
}

function finalResponseFromResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  for (const key of ['finalResponse', 'response', 'text', 'outputText']) {
    if (typeof record[key] === 'string' && String(record[key]).trim()) return String(record[key]);
  }
  return '';
}

async function importOptionalCodexSdk(): Promise<CodexSdkModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<CodexSdkModule>;
  return dynamicImport('@openai/codex-sdk');
}

export class SdkCodexClient implements CodexClient {
  constructor(private importSdk: () => Promise<CodexSdkModule> = importOptionalCodexSdk) {}

  async deliverComment(input: CodexDeliveryInput): Promise<CodexDeliveryResult> {
    const targetThreadId = input.target.threadId;
    if (!targetThreadId) {
      throw new DeliveryTransportError('missing_thread', 'Codex delivery target is missing threadId', false);
    }
    const effort = normalizeEffort(input.target.effort);
    let sdk: CodexSdkModule;
    try {
      sdk = await this.importSdk();
    } catch (error) {
      throw new DeliveryTransportError(
        'codex_sdk_unavailable',
        error instanceof Error ? error.message : 'Codex SDK could not be loaded',
        false,
        'Install and configure @openai/codex-sdk, or switch this target to app-server mode.'
      );
    }

    const runOptions = buildSdkRunOptions(input.target, effort);
    const client = sdk.Codex ? new sdk.Codex(runOptions) : undefined;
    const resume = client?.resumeThread ?? sdk.resumeThread;
    if (!resume) {
      throw new DeliveryTransportError('codex_sdk_invalid', 'Codex SDK does not expose resumeThread', false);
    }

    let thread: unknown;
    try {
      thread = await resume.call(client, targetThreadId, runOptions);
    } catch (error) {
      throw new DeliveryTransportError(
        'thread_not_found',
        error instanceof Error ? error.message : 'Unable to resume Codex thread',
        false,
        'Verify the target thread id and Codex authentication, then retry delivery.'
      );
    }

    const actualThreadId = observedThreadId(thread);
    if (actualThreadId && actualThreadId !== targetThreadId) {
      throw new DeliveryTransportError(
        'thread_mismatch',
        `Codex resumed thread '${actualThreadId}' instead of configured thread '${targetThreadId}'`,
        false,
        'Verify the target thread id before retrying; delivery failed closed.'
      );
    }
    if (!thread || typeof (thread as { run?: unknown }).run !== 'function') {
      throw new DeliveryTransportError('codex_sdk_invalid', 'Resumed Codex thread does not expose run(prompt)', false);
    }

    try {
      const result = await (thread as { run(prompt: string): Promise<unknown> }).run(input.prompt);
      const finalResponse = finalResponseFromResult(result);
      if (!finalResponse) {
        throw new DeliveryTransportError('empty_codex_response', 'Codex completed without a final response', true);
      }
      const turnId = result && typeof result === 'object' && typeof (result as Record<string, unknown>).turnId === 'string'
        ? String((result as Record<string, unknown>).turnId)
        : undefined;
      return {
        finalResponse,
        threadId: actualThreadId ?? targetThreadId,
        turnId,
        raw: result && typeof result === 'object' ? result as Record<string, unknown> : { result }
      };
    } catch (error) {
      if (error instanceof DeliveryTransportError) throw error;
      const message = error instanceof Error ? error.message : 'Codex turn failed before completion';
      if (codexAuthConfigError(message)) {
        throw new DeliveryTransportError(
          'codex_auth_required',
          message,
          false,
          'Configure PLAN_REVIEW_CODEX_HOME or delivery auth/provider settings, then retry delivery.'
        );
      }
      throw new DeliveryTransportError(
        'codex_turn_failed',
        message,
        true
      );
    }
  }
}
