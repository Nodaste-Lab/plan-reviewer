import { z } from 'zod';

export const commentStatusSchema = z.enum(['pending', 'claimed', 'acknowledged', 'resolved']);
export const anchorTypeSchema = z.enum(['dom', 'text_range', 'image']);
export const anchorStateSchema = z.enum(['mapped', 'stale', 'unmapped']);
export const claimModeSchema = z.enum(['one', 'selected', 'bulk']);
export const eventTypeSchema = z.enum([
  'comment.created',
  'comment.claimed',
  'comment.acknowledged',
  'comment.resolved',
  'comment.released',
  'plan.version.registered',
  'plan.version.synced',
  'plan.sync.failed',
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
  sourcePath: z.string().min(1).optional(),
  sourceMtimeMs: z.number().nonnegative().optional(),
  sourceSize: z.number().int().nonnegative().optional(),
  watchMode: z.enum(['filesystem', 'snapshot']).default('snapshot'),
  assets: z.array(z.object({
    sourceUrl: z.string().min(1),
    absolutePath: z.string().optional(),
    bytesBase64: z.string().optional()
  })).optional(),
  updateMode: z.enum(['upsert', 'new-thread']).default('upsert')
}).superRefine((input, context) => {
  if (input.watchMode === 'filesystem' && !input.sourcePath) {
    context.addIssue({
      code: 'custom',
      path: ['sourcePath'],
      message: 'sourcePath is required when watchMode is filesystem'
    });
  }
});

export const createCommentSchema = z.object({
  versionId: z.string().min(1),
  body: z.string().min(1),
  anchorType: anchorTypeSchema,
  anchor: z.record(z.string(), z.unknown()),
  markerScreenshot: markerScreenshotSchema.optional(),
  createdBy: z.object({ displayName: z.string().optional() }).optional(),
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

export type RegisterPlanInput = z.infer<typeof registerPlanSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ClaimCommentsInput = z.infer<typeof claimCommentsSchema>;
export type AckCommentInput = z.infer<typeof ackCommentSchema>;
export type ResolveCommentInput = z.infer<typeof resolveCommentSchema>;
