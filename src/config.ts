import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServiceConfig {
  url?: string;
  codexDelivery?: {
    enabled?: boolean | string;
    mode?: 'sdk' | 'app-server' | 'fake' | 'webhook' | string;
    intervalMs?: number | string;
  };
  updateChecks?: {
    enabled?: boolean | string;
    stableFormulaUrl?: string;
    headCompareUrl?: string;
    timeoutMs?: number | string;
    cacheMs?: number | string;
  };
}

export interface DeliveryWorkerConfig {
  enabled: boolean;
  mode: 'sdk' | 'app-server' | 'fake' | 'webhook';
  intervalMs: number;
  serviceUrl: string;
}

export interface UpdateCheckConfig {
  enabled: boolean;
  stableFormulaUrl?: string;
  headCompareUrl?: string;
  timeoutMs: number;
  cacheMs: number;
  userConfigFile: string;
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

export function userConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'plan-reviewer', 'config.json');
}

export function readUserConfig(filePath = userConfigPath()): Partial<ServiceConfig> {
  return readJson(filePath);
}

export function writeUserConfig(config: Partial<ServiceConfig>, filePath = userConfigPath()): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.config-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function setUpdateChecksEnabled(enabled: boolean, filePath = userConfigPath()): Partial<ServiceConfig> {
  const current = readUserConfig(filePath);
  const next = {
    ...current,
    updateChecks: {
      ...(current.updateChecks ?? {}),
      enabled
    }
  };
  writeUserConfig(next, filePath);
  return next;
}

function parseEnabled(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(1|true|yes|enabled)$/i.test(value)) return true;
    if (/^(0|false|no|disabled)$/i.test(value)) return false;
  }
  return undefined;
}

function parseMode(value: unknown): DeliveryWorkerConfig['mode'] | undefined {
  return value === 'app-server' || value === 'fake' || value === 'sdk' || value === 'webhook' ? value : undefined;
}

function parseIntervalMs(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined;
}

export function resolveServiceUrl(explicitUrl?: string, cwd = process.cwd()): string {
  const explicit = normalizeUrl(explicitUrl);
  if (explicit) return explicit;
  const env = normalizeUrl(process.env.PLAN_REVIEW_URL);
  if (env) return env;

  const project = readJson(path.join(cwd, '.plan-reviewer.json'));
  const projectUrl = normalizeUrl(project.url);
  if (projectUrl) return projectUrl;

  const user = readJson(userConfigPath());
  const userUrl = normalizeUrl(user.url);
  if (userUrl) return userUrl;

  return 'http://127.0.0.1:4317';
}

export function resolveDeliveryWorkerConfig(options: { serviceUrl?: string; userConfigFile?: string } = {}): DeliveryWorkerConfig {
  const user = readJson(options.userConfigFile ?? userConfigPath());
  const configured = user.codexDelivery ?? {};
  const envEnabled = parseEnabled(process.env.PLAN_REVIEW_CODEX_DELIVERY);
  const envMode = parseMode(process.env.PLAN_REVIEW_CODEX_DELIVERY_MODE);
  const envIntervalMs = parseIntervalMs(process.env.PLAN_REVIEW_CODEX_DELIVERY_INTERVAL_MS);

  return {
    enabled: envEnabled ?? parseEnabled(configured.enabled) ?? false,
    mode: envMode ?? parseMode(configured.mode) ?? 'sdk',
    intervalMs: envIntervalMs ?? parseIntervalMs(configured.intervalMs) ?? 10000,
    serviceUrl: options.serviceUrl ?? resolveServiceUrl()
  };
}

export function resolveUpdateCheckConfig(options: { userConfigFile?: string } = {}): UpdateCheckConfig {
  const userConfigFile = options.userConfigFile ?? userConfigPath();
  const configured = readJson(userConfigFile).updateChecks ?? {};
  return {
    enabled: parseEnabled(configured.enabled) ?? true,
    stableFormulaUrl: parseUrl(configured.stableFormulaUrl),
    headCompareUrl: parseUrl(configured.headCompareUrl),
    timeoutMs: parseIntervalMs(configured.timeoutMs) ?? 5000,
    cacheMs: parseIntervalMs(configured.cacheMs) ?? 6 * 60 * 60 * 1000,
    userConfigFile
  };
}
