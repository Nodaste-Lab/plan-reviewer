export interface RegistrationReferenceImplementation {
  harness: string;
  tool: string;
  command: string;
}

import { agentNextCommand, durableAgentNextCommand, optionalWatchCommand } from './agentNext.js';

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

export function buildRegistrationAgentInstructions(input: { planId: string; reviewUrl: string }): RegistrationAgentInstructions {
  const commands = renderRegistrationInstructionCommands({ planId: input.planId }, undefined);
  return {
    type: instructionType,
    required: true,
    summary: 'Use the queue-backed agent next command as the primary browser-comment listener loop.',
    nextAction: 'Drain pending comments with agent next --no-wait, then listen with agent next --wait before continuing implementation or review work.',
    planId: input.planId,
    reviewUrl: input.reviewUrl,
    serviceUrlRequired: true,
    serviceUrlInstruction: 'API consumers should render agent next commands with --url <registration service URL> before execution. The optional watch command is debug-only and is not the correctness-critical delivery path.',
    preferredCommand: commands.preferredCommand,
    drainCommand: commands.drainCommand,
    listenCommand: commands.listenCommand,
    durableCommand: commands.durableCommand,
    optionalWatchCommand: commands.optionalWatchCommand,
    processingLoop: [
      `On start or resume, run ${commands.drainCommand} until it returns status empty.`,
      `Then run ${commands.listenCommand}; it waits, atomically claims one pending browser.comment.v1, prints commentId and claimId, and exits.`,
      'Read the plan and selected context, then make the smallest appropriate plan change.',
      'Acknowledge with the returned ackCommand or plan-review ack <commentId> --claim <claimId> --summary "..." --changed-files thoughts/plans/... --json.',
      'Resolve only after a successful ack when appropriate, then immediately rerun the listen command.',
      'If the plan-review service restarts or the process exits, restart the same agent next command; queue state and claim leases remain authoritative.',
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
