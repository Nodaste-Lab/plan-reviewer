export interface RegistrationReferenceImplementation {
  harness: string;
  tool: string;
  command: string;
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
  preferredCommand: string;
  durableCommand: string;
  processingLoop: string[];
  referenceImplementations: RegistrationReferenceImplementation[];
}

export interface RenderedRegistrationInstructionCommands {
  preferredCommand: string;
  durableCommand: string;
  referenceImplementations: RegistrationReferenceImplementation[];
}

const instructionType = 'plan-review.registration.instructions.v1' as const;
const watcherDirectory = '~/.plan-reviewer/watchers';

function watchCommand(planId: string, options: { conversationOut?: string; serviceUrl?: string } = {}): string {
  return [
    'plan-review',
    'watch',
    planId,
    '--mode',
    'queue',
    '--format',
    'browser-comment',
    ...(options.conversationOut ? ['--conversation-out', options.conversationOut] : []),
    '--json',
    ...(options.serviceUrl ? ['--url', options.serviceUrl] : [])
  ].join(' ');
}

function durableWatcherCommand(planId: string, serviceUrl?: string): string {
  const conversationOut = `${watcherDirectory}/${planId}.ndjson`;
  const inner = watchCommand(planId, { conversationOut, serviceUrl });
  return `mkdir -p ${watcherDirectory} && tmux new-session -d -s plan-review-${planId} '${inner}'`;
}

export function buildRegistrationAgentInstructions(input: { planId: string; reviewUrl: string }): RegistrationAgentInstructions {
  const commands = renderRegistrationInstructionCommands({ planId: input.planId }, undefined);
  return {
    type: instructionType,
    required: true,
    summary: 'Start a monitor for browser comments now and keep it running while you work this plan.',
    nextAction: 'Start the comment watcher before continuing implementation or review work.',
    planId: input.planId,
    reviewUrl: input.reviewUrl,
    serviceUrlRequired: true,
    serviceUrlInstruction: 'API consumers should render watcher commands with --url <registration service URL> before execution; for durable tmux commands, the --url flag belongs inside the quoted inner watcher command.',
    preferredCommand: commands.preferredCommand,
    durableCommand: commands.durableCommand,
    processingLoop: [
      'Receive a browser.comment.v1 payload from the watcher.',
      `Claim that event with plan-review queue claim ${input.planId} --ids <commentId> --json and read <claimId> from claimed[0].claim.id in CLI JSON (raw API data.claimed[0].claim.id); use --one only as a fallback if a future event shape does not expose a comment ID.`,
      'Read the plan and selected context, then make the smallest appropriate plan change.',
      'Acknowledge with plan-review ack <commentId> --claim <claimId> --summary "..." --changed-files thoughts/plans/... --json.',
      'Resolve with plan-review resolve <commentId> --note "Done" --json only after the reviewer-visible issue is complete.'
    ],
    referenceImplementations: commands.referenceImplementations
  };
}

export function renderRegistrationInstructionCommands(input: { planId: string }, serviceUrl?: string): RenderedRegistrationInstructionCommands {
  return {
    preferredCommand: watchCommand(input.planId, { serviceUrl }),
    durableCommand: durableWatcherCommand(input.planId, serviceUrl),
    referenceImplementations: [
      { harness: 'pi', tool: 'process', command: watchCommand(input.planId, { serviceUrl }) },
      { harness: 'durable-shell', tool: 'tmux', command: durableWatcherCommand(input.planId, serviceUrl) }
    ]
  };
}
