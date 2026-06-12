export const agentNextType = 'plan-review.agent.next.v1' as const;

export interface AgentNextEmptyResult {
  type: typeof agentNextType;
  status: 'empty';
  planId: string;
}

export interface AgentNextClaimedResult {
  type: typeof agentNextType;
  status: 'claimed';
  planId: string;
  commentId: string;
  claimId: string;
  reviewMode?: string;
  planPath?: string;
  sourcePath?: string;
  source?: Record<string, unknown>;
  conversationPayload: Record<string, unknown>;
  ackCommand: string;
  resolveCommand: string;
  resolveAfterAck: true;
}

export type AgentNextResult = AgentNextEmptyResult | AgentNextClaimedResult;

export function agentNextCommand(planId: string, options: { wait?: boolean; serviceUrl?: string } = {}): string {
  return [
    'plan-review',
    'agent',
    'next',
    planId,
    options.wait ? '--wait' : '--no-wait',
    '--json',
    ...(options.serviceUrl ? ['--url', options.serviceUrl] : [])
  ].join(' ');
}

export function optionalWatchCommand(planId: string, serviceUrl?: string): string {
  return [
    'plan-review',
    'watch',
    planId,
    '--mode',
    'queue',
    '--format',
    'browser-comment',
    '--json',
    ...(serviceUrl ? ['--url', serviceUrl] : [])
  ].join(' ');
}

export function durableAgentNextCommand(planId: string, serviceUrl?: string): string {
  const inner = agentNextCommand(planId, { wait: true, serviceUrl });
  return `until ${inner}; do sleep 1; done`;
}

export function buildAgentNextEmpty(planId: string): AgentNextEmptyResult {
  return { type: agentNextType, status: 'empty', planId };
}

export function buildAgentNextClaimed(input: {
  planId: string;
  commentId: string;
  claimId: string;
  conversationPayload: Record<string, unknown>;
  serviceUrl: string;
  reviewMode?: string;
  planPath?: string;
  sourcePath?: string;
  source?: Record<string, unknown>;
}): AgentNextClaimedResult {
  return {
    type: agentNextType,
    status: 'claimed',
    planId: input.planId,
    commentId: input.commentId,
    claimId: input.claimId,
    reviewMode: input.reviewMode,
    planPath: input.planPath,
    sourcePath: input.sourcePath,
    source: input.source,
    conversationPayload: input.conversationPayload,
    ackCommand: `plan-review ack ${input.commentId} --claim ${input.claimId} --summary "..." --changed-files <paths> --json --url ${input.serviceUrl}`,
    resolveCommand: `plan-review resolve ${input.commentId} --note "Done" --json --url ${input.serviceUrl}`,
    resolveAfterAck: true
  };
}
