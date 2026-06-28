export interface RegistrationReferenceImplementation {
  harness: string;
  tool: string;
  command: string;
}

import { agentNextCommand, durableAgentNextCommand, optionalWatchCommand } from './agentNext.js';

export interface RegistrationSourceGuidance {
  sourceType: 'markdoc' | 'legacy-html' | 'unknown';
  authoritativeSourcePath?: string;
  registeredArtifactPath?: string;
  summary: string;
  editInstructions: string[];
  templateInstructions: string[];
}

export interface RegistrationAgentInstructions {
  type: 'plan-review.registration.instructions.v1';
  required: true;
  summary: string;
  nextAction: string;
  planId: string;
  reviewUrl: string;
  serviceUrlRequired: true;
  serviceUrlInstruction: string;
  sourceGuidance: RegistrationSourceGuidance;
  preferredCommand: string;
  drainCommand: string;
  listenCommand: string;
  durableCommand: string;
  optionalWatchCommand: string;
  processingLoop: string[];
  referenceImplementations: RegistrationReferenceImplementation[];
}

export interface RenderedRegistrationInstructionCommands {
  preferredCommand: string;
  drainCommand: string;
  listenCommand: string;
  durableCommand: string;
  optionalWatchCommand: string;
  referenceImplementations: RegistrationReferenceImplementation[];
}

const instructionType = 'plan-review.registration.instructions.v1' as const;

function sourceGuidanceFor(input: { planPath?: string; sourcePath?: string }): RegistrationSourceGuidance {
  const authoritativeSourcePath = input.sourcePath ?? input.planPath;
  const sourceType = authoritativeSourcePath?.toLowerCase().endsWith('.markdoc')
    ? 'markdoc'
    : authoritativeSourcePath?.toLowerCase().endsWith('.html') || input.planPath?.toLowerCase().endsWith('.html')
      ? 'legacy-html'
      : 'unknown';
  if (sourceType === 'markdoc') {
    return {
      sourceType,
      ...(authoritativeSourcePath ? { authoritativeSourcePath } : {}),
      ...(input.planPath ? { registeredArtifactPath: input.planPath } : {}),
      summary: 'Edit the Markdoc source; the sibling HTML is generated review output.',
      editInstructions: [
        `Make plan changes in ${authoritativeSourcePath ?? 'the .markdoc source'}, not in the generated HTML artifact.`,
        'Register or re-register the .markdoc path; plan-review compiles it to the browser-reviewed HTML artifact and keeps source sync attached to Markdoc.',
        'If compilation fails, fix the Markdoc source; the service keeps serving the last good generated HTML until sync succeeds.'
      ],
      templateInstructions: [
        'For future plans in this repo, prefer reusable Markdoc templates registered in thoughts/plans/AGENTS.md under a "Plan templates" section.',
        'Store templates as thoughts/plans/templates/<template-name>.markdoc unless repo guidance names a different directory.',
        'Copy a template to thoughts/plans/<slug>.markdoc, replace placeholders, then compile/register the copied plan; do not register template files themselves as review plans.'
      ]
    };
  }
  if (sourceType === 'legacy-html') {
    return {
      sourceType,
      ...(authoritativeSourcePath ? { authoritativeSourcePath } : {}),
      ...(input.planPath ? { registeredArtifactPath: input.planPath } : {}),
      summary: 'This registration is legacy HTML-only unless a sibling Markdoc source is added intentionally.',
      editInstructions: [
        `Edit ${authoritativeSourcePath ?? 'the registered HTML file'} only because no Markdoc source was registered.`,
        'For new plans, prefer thoughts/plans/<slug>.markdoc and register the .markdoc path so generated HTML remains derived output.',
        'Do not add a sibling .markdoc with the same slug unless intentionally migrating; the compiler refuses to overwrite non-generated HTML without --force.'
      ],
      templateInstructions: [
        'For future plans in this repo, register reusable Markdoc templates in thoughts/plans/AGENTS.md under a "Plan templates" section.',
        'Store templates as thoughts/plans/templates/<template-name>.markdoc unless repo guidance names a different directory.',
        'Copy a template to thoughts/plans/<slug>.markdoc, replace placeholders, then compile/register the copied plan; do not register template files themselves as review plans.'
      ]
    };
  }
  return {
    sourceType,
    ...(authoritativeSourcePath ? { authoritativeSourcePath } : {}),
    ...(input.planPath ? { registeredArtifactPath: input.planPath } : {}),
    summary: 'Prefer Markdoc source plans for future reviewed-plan work.',
    editInstructions: [
      'Identify the authoritative source file before editing. Prefer .markdoc sources; treat generated .html as derived output when Markdoc exists.',
      'Register or re-register the authoritative source path with truthful execution-readiness metadata.'
    ],
    templateInstructions: [
      'For future plans in this repo, register reusable Markdoc templates in thoughts/plans/AGENTS.md under a "Plan templates" section.',
      'Store templates as thoughts/plans/templates/<template-name>.markdoc unless repo guidance names a different directory.',
      'Copy a template to thoughts/plans/<slug>.markdoc, replace placeholders, then compile/register the copied plan; do not register template files themselves as review plans.'
    ]
  };
}

export function buildRegistrationAgentInstructions(input: { planId: string; reviewUrl: string; serviceUrl?: string; planPath?: string; sourcePath?: string }): RegistrationAgentInstructions {
  const commands = renderRegistrationInstructionCommands({ planId: input.planId }, input.serviceUrl);
  const sourceGuidance = sourceGuidanceFor(input);
  return {
    type: instructionType,
    required: true,
    summary: 'Use the queue-backed agent next command as the primary browser-comment listener loop; edit the authoritative Markdoc source when present; align reviewer status before implementation; after creating a PR, link and refresh PR status for this plan.',
    nextAction: 'Before draining or listening for comments, identify the authoritative plan source from sourceGuidance, then set this plan active so deferred or archived plans can accept queue claims. Then drain pending comments with agent next --no-wait and listen with agent next --wait before continuing implementation or review work. After a claim, process and ack it before starting another listener. Before implementation, align this plan in_progress when board columns are applicable. After creating a PR, run plan-review pr link with --service-url and plan-review pr refresh with --url for this plan before final handoff.',
    planId: input.planId,
    reviewUrl: input.reviewUrl,
    serviceUrlRequired: true,
    serviceUrlInstruction: 'API consumers should render agent next commands with --url <registration service URL> before execution. PR handoff commands must also target the same service: pr link uses --service-url <registration service URL>, while pr refresh uses --url <registration service URL>. The optional watch command is debug-only and is not the correctness-critical delivery path.',
    sourceGuidance,
    preferredCommand: commands.preferredCommand,
    drainCommand: commands.drainCommand,
    listenCommand: commands.listenCommand,
    durableCommand: commands.durableCommand,
    optionalWatchCommand: commands.optionalWatchCommand,
    processingLoop: [
      `On start or resume, use sourceGuidance first: ${sourceGuidance.summary}`,
      ...sourceGuidance.editInstructions,
      ...sourceGuidance.templateInstructions,
      `Before any queue drain or listen command, run plan-review lifecycle set ${input.planId} active --url ${input.serviceUrl ?? '<registration service URL>'}.`,
      `Then run ${commands.drainCommand} until it returns status empty.`,
      `Then run ${commands.listenCommand}; it waits, atomically claims one pending browser.comment.v1, prints commentId and claimId, and exits successfully after exactly one claim.`,
      'If using a managed background process, restart the listener only after the claimed comment has been processed and acknowledged; do not blindly loop successful claim commands or pre-claim multiple comments.',
      `Before implementation starts for this plan, when board columns are applicable, inspect them with plan-review columns list --json --url ${input.serviceUrl ?? '<registration service URL>'}, then set plan-review column set ${input.planId} in_progress --url ${input.serviceUrl ?? '<registration service URL>'} when that column is available and visible. If Kanban is disabled or the document type does not support board columns, skip only the column alignment and continue after lifecycle is active. If columns are applicable but the in-progress column is missing or ambiguous, stop with an actionable blocker instead of silently building from Backlog or Planning.`,
      'Read the plan and selected context, then make the smallest appropriate plan change.',
      'After updating source-plan Progress, confirm plan-reviewer reflects the latest source sync or re-register the plan before advancing phases.',
      `Acknowledge with the returned ackCommand or plan-review ack <commentId> --claim <claimId> --summary "..." --changed-files ${sourceGuidance.authoritativeSourcePath ?? 'thoughts/plans/<slug>.markdoc'} --json; report the Markdoc source in changed-files when it exists, not the generated HTML.`,
      'Resolve only after a successful ack when appropriate, then immediately rerun the listen command.',
      'If the plan-review service restarts or the listener exits before a claim, restart the same agent next command; queue state and claim leases remain authoritative.',
      `After creating a GitHub PR, run plan-review pr link ${input.planId} --url <github-pr-url> --service-url <registration service URL> --json, then plan-review pr refresh ${input.planId} --url <registration service URL> --json before final handoff.`,
      'Verify the index shows the expected PR state (open, merged, closed, unknown, or stale); do not rely on manual plan text edits for PR status.',
      'Use plan-review watch only as an optional low-latency/debug stream, not as the correctness-critical delivery path.'
    ],
    referenceImplementations: commands.referenceImplementations
  };
}

export function renderRegistrationInstructionCommands(input: { planId: string }, serviceUrl?: string): RenderedRegistrationInstructionCommands {
  const drainCommand = agentNextCommand(input.planId, { wait: false, serviceUrl });
  const listenCommand = agentNextCommand(input.planId, { wait: true, serviceUrl });
  const durableCommand = durableAgentNextCommand(input.planId, serviceUrl);
  const watchCommand = optionalWatchCommand(input.planId, serviceUrl);
  return {
    preferredCommand: listenCommand,
    drainCommand,
    listenCommand,
    durableCommand,
    optionalWatchCommand: watchCommand,
    referenceImplementations: [
      { harness: 'pi', tool: 'process', command: listenCommand },
      { harness: 'durable-shell', tool: 'shell-loop', command: durableCommand },
      { harness: 'debug-stream', tool: 'watch', command: watchCommand }
    ]
  };
}
