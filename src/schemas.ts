import { z } from 'zod';

export const commentStatusSchema = z.enum(['pending', 'claimed', 'acknowledged', 'resolved']);
export const anchorTypeSchema = z.enum(['dom', 'text_range', 'image']);
export const anchorStateSchema = z.enum(['mapped', 'stale', 'unmapped']);
export const claimModeSchema = z.enum(['one', 'selected', 'bulk']);
export const planLifecycleStateSchema = z.enum(['active', 'deferred', 'archived']);
export const boardColumnKeySchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'board column keys must use lowercase letters, numbers, underscores, or dashes');
export const noteAuthorSchema = z.object({ displayName: z.string().optional() }).optional();
export const reviewModeSchema = z.enum(['planning', 'collaboration']);
export const threadEntryRoleSchema = z.enum(['human', 'agent', 'system']);
export const deliveryAdapterSchema = z.enum(['codex', 'hermes']);
export const deliveryModeSchema = z.enum(['sdk', 'app-server', 'fake', 'webhook']);
export const deliverySandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export const deliveryEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export const deliveryStatusSchema = z.enum([
  'pending',
  'claiming',
  'delivering',
  'ack_pending',
  'delivered',
  'resolved',
  'retry_wait',
  'ack_failed',
  'failed',
  'externally_claimed',
  'externally_acknowledged',
  'externally_resolved',
  'externally_deleted',
  'paused'
]);
export const eventTypeSchema = z.enum([
  'comment.created',
  'comment.claimed',
  'comment.acknowledged',
  'comment.resolved',
  'comment.released',
  'comment.deleted',
  'plan.version.registered',
  'plan.version.synced',
  'plan.sync.failed',
  'plan.archived',
  'plan.unarchived',
  'plan.deferred',
  'plan.resumed',
  'plan.note.created',
  'plan.mode.changed',
  'plan.lifecycle.changed',
  'plan.column.changed',
  'plan.columns.changed',
  'plan.pin.changed',
  'plan.project.changed',
  'comment.thread_entry.created',
  'heartbeat'
]);

export const markerScreenshotSchema = z.object({
  contentType: z.literal('image/png'),
  bytesBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  captureRect: z.record(z.string(), z.unknown()),
  viewport: z.record(z.string(), z.unknown())
});

export const planPublicationMetadataSchema = z.object({
  worktreePath: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  linearIssue: z.string().trim().min(1).optional(),
  executionReady: z.boolean(),
  executionReadyBasis: z.literal('agent-review-results')
});

export const planPullRequestSchema = z.object({
  provider: z.literal('github'),
  url: z.string().url().refine(value => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value), {
    message: 'url must be a canonical GitHub PR URL: https://github.com/<owner>/<repo>/pull/<number>'
  }),
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  number: z.number().int().positive(),
  headRef: z.string().trim().min(1),
  headRepo: z.string().trim().min(1).optional(),
  baseRef: z.string().trim().min(1),
  state: z.enum(['open', 'closed', 'unknown']),
  merged: z.boolean(),
  mergedAt: z.string().datetime().optional(),
  lastCheckedAt: z.string().datetime().optional(),
  source: z.enum(['explicit', 'auto-discovered', 'refreshed']),
  lastRefreshError: z.string().trim().min(1).optional(),
  status: z.enum(['unlinked', 'open', 'merged', 'closed', 'unknown', 'stale']).optional()
}).superRefine((input, context) => {
  const urlMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(input.url);
  if (urlMatch && (urlMatch[1].toLowerCase() !== input.owner.toLowerCase() || urlMatch[2].toLowerCase() !== input.repo.toLowerCase() || Number(urlMatch[3]) !== input.number)) {
    context.addIssue({ code: 'custom', path: ['url'], message: 'url owner/repo/number must match pull request fields' });
  }
  if (input.merged && !input.mergedAt) {
    context.addIssue({ code: 'custom', path: ['mergedAt'], message: 'mergedAt is required when merged is true' });
  }
  if (!input.merged && input.mergedAt) {
    context.addIssue({ code: 'custom', path: ['mergedAt'], message: 'mergedAt requires merged to be true' });
  }
});

const deliveryTargetUpdateBaseSchema = z.object({
  adapter: deliveryAdapterSchema.default('codex'),
  enabled: z.boolean().default(false),
  mode: deliveryModeSchema.default('sdk'),
  threadId: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  sandbox: deliverySandboxSchema.optional(),
  model: z.string().trim().min(1).optional(),
  effort: deliveryEffortSchema.optional(),
  autoResolve: z.boolean().default(false)
});

function requireDeliveryThreadWhenEnabled(input: { enabled?: boolean; threadId?: string; adapter?: DeliveryAdapter; mode?: DeliveryMode }, context: z.RefinementCtx): void {
  if (input.enabled && !input.threadId) {
    context.addIssue({
      code: 'custom',
      path: ['threadId'],
      message: 'threadId is required when delivery is enabled'
    });
  }
  const adapter = input.adapter ?? 'codex';
  if (adapter === 'codex' && input.mode === 'webhook') {
    context.addIssue({
      code: 'custom',
      path: ['mode'],
      message: 'webhook delivery mode is only supported for the hermes adapter'
    });
  }
  if (adapter === 'hermes' && (input.mode === 'sdk' || input.mode === 'app-server')) {
    context.addIssue({
      code: 'custom',
      path: ['mode'],
      message: 'Hermes delivery mode must be fake or webhook'
    });
  }
}

export const deliveryTargetUpdateSchema = deliveryTargetUpdateBaseSchema.superRefine(requireDeliveryThreadWhenEnabled);

export const deliveryTargetSchema = deliveryTargetUpdateSchema.extend({
  planId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const registerPlanSchema = z.object({
  repoKey: z.string().optional(),
  repoName: z.string().min(1),
  remoteUrl: z.string().optional(),
  rootPath: z.string().optional(),
  branch: z.string().min(1),
  commitSha: z.string().optional(),
  planPath: z.string().min(1),
  slug: z.string().optional(),
  html: z.string().min(1),
  fileHash: z.string().min(1),
  publicationMetadata: planPublicationMetadataSchema.optional(),
  reviewMode: reviewModeSchema.optional(),
  sourcePath: z.string().min(1).optional(),
  sourceMtimeMs: z.number().nonnegative().optional(),
  sourceSize: z.number().int().nonnegative().optional(),
  watchMode: z.enum(['filesystem', 'snapshot']).default('snapshot'),
  assets: z.array(z.object({
    sourceUrl: z.string().min(1),
    absolutePath: z.string().optional(),
    bytesBase64: z.string().optional()
  })).optional(),
  updateMode: z.enum(['upsert', 'new-thread']).default('upsert'),
  codexDelivery: deliveryTargetUpdateBaseSchema.omit({ adapter: true }).superRefine(requireDeliveryThreadWhenEnabled).optional()
}).superRefine((input, context) => {
  if (input.watchMode === 'filesystem' && !input.sourcePath) {
    context.addIssue({
      code: 'custom',
      path: ['sourcePath'],
      message: 'sourcePath is required when watchMode is filesystem'
    });
  }
  const inferredMode = input.reviewMode ?? (input.publicationMetadata?.executionReadyBasis || input.planPath.startsWith('thoughts/plans/') ? 'planning' : 'collaboration');
  if (inferredMode === 'planning' && !input.publicationMetadata) {
    context.addIssue({
      code: 'custom',
      path: ['publicationMetadata'],
      message: 'publicationMetadata is required for planning mode'
    });
  }
  if (input.publicationMetadata && input.publicationMetadata.branch !== input.branch) {
    context.addIssue({
      code: 'custom',
      path: ['publicationMetadata', 'branch'],
      message: 'publicationMetadata.branch must match branch'
    });
  }
});

export const commentAuthorSchema = z.object({
  type: z.enum(['reviewer', 'agent']).optional(),
  displayName: z.string().optional(),
  agentId: z.string().trim().min(1).optional()
}).superRefine((input, context) => {
  if (input.type === 'agent' && !input.displayName?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['displayName'],
      message: 'Agent comments require createdBy.displayName'
    });
  }
  if (input.agentId && input.type !== 'agent') {
    context.addIssue({
      code: 'custom',
      path: ['agentId'],
      message: 'agentId is only valid for agent comments'
    });
  }
});

export const createCommentSchema = z.object({
  versionId: z.string().min(1),
  body: z.string().min(1),
  anchorType: anchorTypeSchema,
  anchor: z.record(z.string(), z.unknown()),
  markerScreenshot: markerScreenshotSchema.optional(),
  createdBy: commentAuthorSchema.optional(),
  clientMutationId: z.string().optional()
});

export const createDomCommentSchema = z.object({
  body: z.string().trim().min(1),
  target: z.object({
    planNodeId: z.string().trim().min(1).optional(),
    selector: z.string().trim().min(1).optional()
  }).superRefine((input, context) => {
    if (!input.planNodeId && !input.selector) {
      context.addIssue({ code: 'custom', message: 'target requires planNodeId or selector' });
    }
    if (input.planNodeId && input.selector) {
      context.addIssue({ code: 'custom', message: 'target.planNodeId and target.selector are mutually exclusive' });
    }
    if (input.selector && !/^#\S+$/.test(input.selector)) {
      context.addIssue({ code: 'custom', path: ['selector'], message: 'target.selector must be an exact id selector such as #ac-2' });
    }
  }),
  createdBy: z.object({
    type: z.literal('agent').optional(),
    displayName: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional()
  }).transform(input => ({ ...input, type: 'agent' as const })),
  clientMutationId: z.string().optional()
});

export const claimCommentsSchema = z.object({
  mode: claimModeSchema,
  limit: z.number().int().positive().max(200).optional(),
  commentIds: z.array(z.string()).optional(),
  leaseSeconds: z.number().int().positive().max(3600).default(300)
});

export const ackCommentSchema = z.object({
  claimId: z.string().min(1),
  action: z.object({
    runId: z.string().optional(),
    handoffPath: z.string().optional(),
    commitSha: z.string().optional(),
    note: z.string().optional(),
    responseSummary: z.string().optional(),
    changedFiles: z.array(z.string()).optional()
  }).optional(),
  clientMutationId: z.string().optional()
});

export const resolveCommentSchema = z.object({
  resolutionNote: z.string().min(1),
  action: z.object({
    runId: z.string().optional(),
    commitSha: z.string().optional(),
    responseSummary: z.string().optional(),
    changedFiles: z.array(z.string()).optional()
  }).optional()
});

export const releaseCommentSchema = z.object({
  claimId: z.string().min(1),
  reason: z.string().optional()
});

export const changePlanModeSchema = z.object({
  reviewMode: reviewModeSchema
});

export const setPlanLifecycleSchema = z.object({
  lifecycleState: planLifecycleStateSchema
});

export const setPlanBoardColumnSchema = z.object({
  boardColumnKey: boardColumnKeySchema
});

export const setPlanPinnedSchema = z.object({
  pinned: z.boolean()
});

export const setPlanProjectSchema = z.object({
  projectName: z.string().trim().min(1),
  projectKey: z.string().trim().min(1).optional()
});

export const saveBoardColumnsSchema = z.object({
  columns: z.array(z.object({
    key: boardColumnKeySchema,
    label: z.string().trim().min(1),
    position: z.number().int().nonnegative().optional(),
    isDone: z.boolean().optional(),
    hidden: z.boolean().optional()
  })).min(1)
});

export const appendThreadEntrySchema = z.object({
  role: threadEntryRoleSchema.default('agent'),
  body: z.string().trim().min(1),
  createdBy: noteAuthorSchema,
  claimId: z.string().min(1).optional(),
  deliveryAdapter: deliveryAdapterSchema.optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  clientMutationId: z.string().optional()
});

export const claimQueueSchema = z.object({
  adapter: deliveryAdapterSchema.optional(),
  reviewMode: reviewModeSchema.optional(),
  repoKey: z.string().min(1).optional(),
  leaseSeconds: z.number().int().positive().max(3600).default(300)
});

export const createPlanNoteSchema = z.object({
  body: z.string().trim().min(1),
  createdBy: noteAuthorSchema,
  clientMutationId: z.string().optional()
});

export const deferPlanSchema = z.object({
  note: z.string().trim().min(1),
  createdBy: noteAuthorSchema,
  clientMutationId: z.string().optional()
});

export const resumePlanSchema = z.object({
  note: z.string().trim().min(1).optional(),
  createdBy: noteAuthorSchema,
  clientMutationId: z.string().optional()
});

export type ReviewMode = z.infer<typeof reviewModeSchema>;
export type ThreadEntryRole = z.infer<typeof threadEntryRoleSchema>;
export type PlanPublicationMetadata = z.infer<typeof planPublicationMetadataSchema>;
export type PlanPullRequest = z.infer<typeof planPullRequestSchema>;
export type RegisterPlanInput = z.infer<typeof registerPlanSchema>;
export type DeliveryAdapter = z.infer<typeof deliveryAdapterSchema>;
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type DeliveryTargetInput = z.infer<typeof deliveryTargetUpdateSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type CreateDomCommentInput = z.infer<typeof createDomCommentSchema>;
export type ClaimCommentsInput = z.infer<typeof claimCommentsSchema>;
export type AckCommentInput = z.infer<typeof ackCommentSchema>;
export type AppendThreadEntryInput = z.infer<typeof appendThreadEntrySchema>;
export type ClaimQueueInput = z.infer<typeof claimQueueSchema>;
export type ResolveCommentInput = z.infer<typeof resolveCommentSchema>;
export type CreatePlanNoteInput = z.infer<typeof createPlanNoteSchema>;
export type DeferPlanInput = z.infer<typeof deferPlanSchema>;
export type ResumePlanInput = z.infer<typeof resumePlanSchema>;
export type PlanLifecycleState = z.infer<typeof planLifecycleStateSchema>;
export type BoardColumnKey = z.infer<typeof boardColumnKeySchema>;
export type SetPlanLifecycleInput = z.infer<typeof setPlanLifecycleSchema>;
export type SetPlanBoardColumnInput = z.infer<typeof setPlanBoardColumnSchema>;
export type SetPlanPinnedInput = z.infer<typeof setPlanPinnedSchema>;
export type SetPlanProjectInput = z.infer<typeof setPlanProjectSchema>;
export type SaveBoardColumnsInput = z.infer<typeof saveBoardColumnsSchema>;
