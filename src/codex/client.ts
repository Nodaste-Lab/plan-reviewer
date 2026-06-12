import type { CodexDeliveryInput, CodexDeliveryResult } from '../delivery/types.js';

export interface CodexClient {
  deliverComment(input: CodexDeliveryInput): Promise<CodexDeliveryResult>;
}

export class FakeCodexClient implements CodexClient {
  calls: CodexDeliveryInput[] = [];

  constructor(private options: { fail?: Error; response?: Partial<CodexDeliveryResult> } = {}) {}

  async deliverComment(input: CodexDeliveryInput): Promise<CodexDeliveryResult> {
    this.calls.push(input);
    if (this.options.fail) throw this.options.fail;
    return {
      finalResponse: this.options.response?.finalResponse ?? `Addressed ${input.comment.id}`,
      threadId: this.options.response?.threadId ?? input.target.threadId ?? 'fake-thread',
      turnId: this.options.response?.turnId ?? `fake-turn-${this.calls.length}`,
      raw: this.options.response?.raw ?? { mode: 'fake' },
      fullyResolved: this.options.response?.fullyResolved,
      changedFiles: this.options.response?.changedFiles ?? []
    };
  }
}
