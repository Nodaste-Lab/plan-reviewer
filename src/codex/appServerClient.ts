import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexClient } from './client.js';
import { DeliveryTransportError, type CodexDeliveryInput, type CodexDeliveryResult } from '../delivery/types.js';
import { buildAppServerThreadOptions, buildCodexProcessEnv, codexAuthConfigError } from './config.js';

export function buildAppServerInitializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'plan-reviewer',
        title: 'Plan Reviewer',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    }
  };
}

export function buildAppServerTurnStartRequest(threadId: string, prompt: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'turn-start',
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: prompt }]
    }
  };
}

export function buildAppServerThreadResumeRequest(threadId: string, input: CodexDeliveryInput): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'thread-resume',
    method: 'thread/resume',
    params: {
      threadId,
      ...buildAppServerThreadOptions(input.target)
    }
  };
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['finalResponse', 'text', 'outputText', 'delta']) {
    if (typeof record[key] === 'string' && String(record[key]).trim()) return String(record[key]);
  }
  for (const key of ['message', 'item', 'content']) {
    const nested = messageText(record[key]);
    if (nested) return nested;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? 'Codex app-server error');
  const record = error as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.code === 'string' || typeof record.code === 'number') return `Codex app-server error ${record.code}`;
  return 'Codex app-server error';
}

export function deliveryErrorFromAppServerJsonRpc(error: unknown): DeliveryTransportError {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (codexAuthConfigError(message)) {
    return new DeliveryTransportError('codex_auth_required', message, false, 'Configure Codex authentication or provider settings, then retry delivery.');
  }
  if (lower.includes('overload') || lower.includes('unavailable') || lower.includes('temporarily')) {
    return new DeliveryTransportError('codex_app_server_unavailable', message, true);
  }
  if (lower.includes('active turn') || lower.includes('already running') || lower.includes('conflict')) {
    return new DeliveryTransportError('thread_busy', message, true);
  }
  if (lower.includes('invalid session') || lower.includes('thread') || lower.includes('no rollout')) {
    return new DeliveryTransportError('thread_not_found', message, false, 'Verify the target Codex thread id, then retry delivery.');
  }
  return new DeliveryTransportError('codex_app_server_error', message, false, 'Inspect the Codex app-server error and retry after correcting the target configuration.');
}

export class AppServerCodexClient implements CodexClient {
  constructor(private options: { command?: string; args?: string[]; timeoutMs?: number } = {}) {}

  async deliverComment(input: CodexDeliveryInput): Promise<CodexDeliveryResult> {
    const threadId = input.target.threadId;
    if (!threadId) {
      throw new DeliveryTransportError('missing_thread', 'Codex delivery target is missing threadId', false);
    }
    const child = spawn(this.options.command ?? 'codex', this.options.args ?? ['app-server'], {
      cwd: input.target.cwd,
      env: buildCodexProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return this.runJsonRpc(child, threadId, input);
  }

  private runJsonRpc(child: ChildProcessWithoutNullStreams, threadId: string, input: CodexDeliveryInput): Promise<CodexDeliveryResult> {
    const timeoutMs = this.options.timeoutMs ?? 15 * 60 * 1000;
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const stderrChunks: string[] = [];
      let streamedFinalResponse = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new DeliveryTransportError('codex_app_server_timeout', 'Codex app-server turn timed out before completion', true));
      }, timeoutMs);
      const fail = (error: DeliveryTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const finish = (result: CodexDeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(result);
      };
      child.stderr.on('data', chunk => stderrChunks.push(String(chunk)));
      child.on('error', error => fail(new DeliveryTransportError('codex_app_server_unavailable', error.message, true)));
      child.on('exit', code => {
        if (!settled) {
          const stderr = stderrChunks.join('').trim();
          if (stderr && codexAuthConfigError(stderr)) {
            fail(new DeliveryTransportError('codex_auth_required', stderr, false, 'Configure PLAN_REVIEW_CODEX_HOME or delivery auth/provider settings, then retry delivery.'));
            return;
          }
          fail(new DeliveryTransportError(
            'codex_app_server_exited',
            `Codex app-server exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`,
            true
          ));
        }
      });
      lines.on('line', line => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.error) {
          fail(deliveryErrorFromAppServerJsonRpc(message.error));
          return;
        }
        if (message.method === 'item/agentMessage/delta' || message.method === 'item/completed') {
          streamedFinalResponse += messageText(message.params);
          return;
        }
        if (message.method === 'turn/completed') {
          const params = typeof message.params === 'object' && message.params ? message.params as Record<string, unknown> : {};
          const finalResponse = messageText(params) || streamedFinalResponse.trim();
          if (!finalResponse) {
            fail(new DeliveryTransportError('empty_codex_response', 'Codex app-server completed without a final response', true));
            return;
          }
          const turn = typeof params.turn === 'object' && params.turn ? params.turn as Record<string, unknown> : undefined;
          finish({
            finalResponse,
            threadId,
            turnId: typeof params.turnId === 'string' ? params.turnId : typeof turn?.id === 'string' ? turn.id : undefined,
            raw: params
          });
        }
      });
      for (const request of [
        buildAppServerInitializeRequest(),
        buildAppServerThreadResumeRequest(threadId, input),
        buildAppServerTurnStartRequest(threadId, input.prompt)
      ]) {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      }
    });
  }
}
