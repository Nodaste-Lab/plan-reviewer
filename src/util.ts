import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PlanReviewError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details: unknown = {},
    public nextAction = ''
  ) {
    super(message);
  }
}

export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function fail(error: PlanReviewError) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      nextAction: error.nextAction
    }
  };
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function shortHash(data: string): string {
  return sha256(data).slice(0, 12);
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.plan-reviewer');
}

export function defaultDbPath(): string {
  return path.join(defaultDataDir(), 'plan-reviewer.sqlite');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `plan-${shortHash(input)}`;
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
