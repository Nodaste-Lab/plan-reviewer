import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServiceConfig {
  url: string;
}

export interface DeliveryWorkerConfig {
  enabled: boolean;
  mode: 'sdk' | 'app-server' | 'fake';
  intervalMs: number;
  serviceUrl: string;
}

function readJson(filePath: string): Partial<ServiceConfig> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ServiceConfig>;
  } catch {
    return {};
  }
}

function normalizeUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replace(/\/$/, '') : undefined;
}

export function resolveServiceUrl(explicitUrl?: string, cwd = process.cwd()): string {
  const explicit = normalizeUrl(explicitUrl);
  if (explicit) return explicit;
  const env = normalizeUrl(process.env.PLAN_REVIEW_URL);
  if (env) return env;

  const project = readJson(path.join(cwd, '.plan-reviewer.json'));
  const projectUrl = normalizeUrl(project.url);
  if (projectUrl) return projectUrl;

  const user = readJson(path.join(os.homedir(), '.config', 'plan-reviewer', 'config.json'));
  const userUrl = normalizeUrl(user.url);
  if (userUrl) return userUrl;

  return 'http://127.0.0.1:4317';
}

export function resolveDeliveryWorkerConfig(options: { serviceUrl?: string } = {}): DeliveryWorkerConfig {
  return {
    enabled: /^(1|true|yes|enabled)$/i.test(process.env.PLAN_REVIEW_CODEX_DELIVERY ?? ''),
    mode: process.env.PLAN_REVIEW_CODEX_DELIVERY_MODE === 'app-server' || process.env.PLAN_REVIEW_CODEX_DELIVERY_MODE === 'fake'
      ? process.env.PLAN_REVIEW_CODEX_DELIVERY_MODE
      : 'sdk',
    intervalMs: Number(process.env.PLAN_REVIEW_CODEX_DELIVERY_INTERVAL_MS ?? 10000),
    serviceUrl: options.serviceUrl ?? resolveServiceUrl()
  };
}
