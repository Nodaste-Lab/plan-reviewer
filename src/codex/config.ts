import os from 'node:os';
import path from 'node:path';
import type { DeliveryTargetRecord } from '../delivery/types.js';

export function codexConfigOverrides(): Record<string, unknown> {
  return {
    'plugins.enabled': false,
    'mcp.enabled': false,
    'connectors.enabled': false,
    'plugins."cloudflare@openai-curated".enabled': false,
    plugins: {},
    mcpServers: {},
    mcp_servers: {},
    connectors: {}
  };
}

export function codexAuthConfigError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('missing bearer') ||
    lower.includes('missing auth') ||
    lower.includes('invalid token') ||
    lower.includes('auth/config') ||
    lower.includes('oauth') ||
    lower.includes('configuration') ||
    lower.includes('provider') ||
    lower.includes('profile') ||
    lower.includes('api key');
}

export function codexDeliveryHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLAN_REVIEW_CODEX_HOME || path.join(os.tmpdir(), 'plan-reviewer-codex-delivery-codex-home');
}

export function buildCodexProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({
      PATH: env.PATH,
      TERM: env.TERM,
      CODEX_HOME: codexDeliveryHome(env),
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      CODEX_API_KEY: env.CODEX_API_KEY
    }).filter(([, value]) => value !== undefined)
  ) as NodeJS.ProcessEnv;
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function buildSdkRunOptions(target: DeliveryTargetRecord, effort?: string): Record<string, unknown> {
  return omitUndefined({
    workingDirectory: target.cwd,
    sandboxMode: target.sandbox,
    model: target.model,
    modelReasoningEffort: effort,
    approvalPolicy: 'never',
    webSearchMode: 'disabled',
    codexHome: codexDeliveryHome(),
    env: buildCodexProcessEnv(),
    config: codexConfigOverrides()
  });
}

export function buildAppServerThreadOptions(target: DeliveryTargetRecord): Record<string, unknown> {
  return omitUndefined({
    cwd: target.cwd,
    sandbox: target.sandbox,
    model: target.model,
    modelReasoningEffort: target.effort,
    approvalPolicy: 'never',
    config: codexConfigOverrides()
  });
}
