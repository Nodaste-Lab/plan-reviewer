import type { DeliveryAdapter, DeliveryMode, DeliveryStatus } from '../schemas.js';
import type { StoredComment } from '../storage/database.js';

export interface DeliveryTargetRecord {
  planId: string;
  adapter: DeliveryAdapter;
  enabled: boolean;
  mode: DeliveryMode;
  threadId?: string;
  cwd?: string;
  sandbox?: string;
  model?: string;
  effort?: string;
  autoResolve: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryOutboxRow {
  id: string;
  planId: string;
  commentId: string;
  adapter: DeliveryAdapter;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  claimId?: string;
  targetThreadId?: string;
  adapterTurnId?: string;
  lastError?: DeliveryErrorShape;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  nextAction?: string;
}

export interface CodexPromptInput {
  planId: string;
  reviewUrl: string;
  serviceUrl: string;
  comment: StoredComment;
  claimId: string;
}

export interface CodexDeliveryInput {
  target: DeliveryTargetRecord;
  comment: StoredComment;
  claimId: string;
  prompt: string;
}

export interface CodexDeliveryResult {
  finalResponse: string;
  threadId: string;
  turnId?: string;
  raw?: Record<string, unknown>;
  fullyResolved?: boolean;
  changedFiles?: string[];
}

export interface HermesDeliveryPayload {
  planId: string;
  commentId: string;
  claimId: string;
  reviewMode: string;
  sourcePath?: string;
  planPath: string;
  anchor: Record<string, unknown>;
  context: Record<string, unknown>;
  screenshot?: Record<string, unknown>;
  threadHistory: StoredComment['threadEntries'];
}

export interface HermesDeliveryInput {
  target: DeliveryTargetRecord;
  payload: HermesDeliveryPayload;
}

export interface HermesDeliveryResult {
  replyBody?: string;
  finalResponse?: string;
  threadId?: string;
  turnId?: string;
  raw?: Record<string, unknown>;
  fullyResolved?: boolean;
  changedFiles?: string[];
}

export class DeliveryTransportError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public nextAction?: string
  ) {
    super(message);
    this.name = 'DeliveryTransportError';
  }
}

export function deliveryErrorShape(error: unknown): DeliveryErrorShape {
  if (error instanceof DeliveryTransportError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      nextAction: error.nextAction
    };
  }
  if (error instanceof Error) {
    return { code: 'delivery_error', message: error.message, retryable: false };
  }
  return { code: 'delivery_error', message: String(error), retryable: false };
}
