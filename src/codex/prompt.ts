import type { CodexPromptInput } from '../delivery/types.js';

function absoluteUrl(base: string, maybePath: string): string {
  if (/^https?:\/\//i.test(maybePath)) return maybePath;
  return `${base.replace(/\/$/, '')}${maybePath.startsWith('/') ? maybePath : `/${maybePath}`}`;
}

export function buildCodexDeliveryPrompt(input: CodexPromptInput): string {
  const reviewUrl = absoluteUrl(input.serviceUrl, input.reviewUrl);
  const payload = JSON.stringify(input.comment.conversationPayload, null, 2);
  return `New plan-reviewer feedback was claimed for an HTML plan.

Plan ID: ${input.planId}
Review URL: ${reviewUrl}
Comment ID: ${input.comment.id}
Claim ID: ${input.claimId}

Task:
1. Inspect the plan and the comment evidence.
2. Make the smallest plan change that addresses the feedback.
3. Run relevant verification if available.
4. Reply with a concise summary, changed files, and whether the feedback is fully resolved.

Important:
- The plan-reviewer service owns queue state.
- Do not run plan-review ack, resolve, release, watch, or agent next commands; the delivery worker records the response after this turn completes.
- Do not start a long polling loop.
- Do not process unrelated comments.
- If you cannot address this comment safely, explain why.

browser.comment.v1 payload:
${payload}
`;
}
