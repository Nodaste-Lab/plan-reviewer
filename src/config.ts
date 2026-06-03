import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServiceConfig {
  url: string;
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
