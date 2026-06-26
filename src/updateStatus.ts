import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMULA_NAME = 'plan-reviewer';
const TAP_FORMULA = 'Nodaste-Lab/plan-reviewer/plan-reviewer';
const DEFAULT_STABLE_FORMULA_URL = 'https://raw.githubusercontent.com/Nodaste-Lab/plan-reviewer/main/Formula/plan-reviewer.rb';
const DEFAULT_HEAD_COMPARE_URL = 'https://api.github.com/repos/Nodaste-Lab/plan-reviewer/compare/{commit}...main';

export type InstallChannel = 'stable' | 'head' | 'dev' | 'unknown' | 'unsupported_channel';
export type UpdateStatusCode = 'up_to_date' | 'update_available' | 'unknown' | 'unsupported_channel' | 'check_failed';

export interface BuildIdentity {
  packageName?: string;
  packageVersion?: string;
  buildCommit?: string;
  formulaName?: string;
  installChannel: InstallChannel;
  metadataSource: string;
  pathEvidence: {
    executablePath: string;
    realExecutablePath: string;
    packageRoot: string;
    realPackageRoot: string;
  };
  homebrew?: {
    formulaName: string;
    cellarVersion: string;
    cellarRoot: string;
  };
}

export interface BuildIdentityOptions {
  executablePath?: string;
  packageRoot?: string;
  buildMetadataPath?: string;
}

export interface UpdateStatus {
  status: UpdateStatusCode;
  checkedAt: string;
  current: BuildIdentity;
  latest?: {
    version?: string;
    commit?: string;
    source: string;
  };
  updateCommand?: string;
  restartCommand?: string;
  verifyCommand?: string;
  nextAction: string;
  error?: string;
}

export interface UpdateCheckOptions {
  identity?: BuildIdentity;
  identityOptions?: BuildIdentityOptions;
  stableFormulaUrl?: string;
  headCompareUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface PackageJson {
  name?: string;
  version?: string;
}

function safeRealpath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function findPackageRoot(startPath = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = safeRealpath(startPath);
  while (true) {
    const packageJson = readJsonFile<PackageJson>(path.join(current, 'package.json'));
    if (packageJson?.name === FORMULA_NAME || packageJson?.version) return current;
    const parent = path.dirname(current);
    if (parent === current) return safeRealpath(startPath);
    current = parent;
  }
}

function readBuildMetadata(realPackageRoot: string, explicitPath?: string): Record<string, unknown> | undefined {
  const candidates = [
    explicitPath,
    path.join(realPackageRoot, 'plan-reviewer-build.json'),
    path.join(realPackageRoot, '.plan-reviewer-build.json'),
    path.join(realPackageRoot, 'build-metadata.json')
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const parsed = readJsonFile<Record<string, unknown>>(candidate);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractBuildCommit(metadata: Record<string, unknown> | undefined): string | undefined {
  return stringValue(metadata?.gitCommit)
    ?? stringValue(metadata?.buildCommit)
    ?? stringValue(metadata?.commit)
    ?? stringValue(metadata?.commitSha);
}

function extractHomebrewCellarPath(filePath: string): { formulaName: string; cellarVersion: string; cellarRoot: string } | undefined {
  const parts = path.resolve(filePath).split(path.sep);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] !== 'Cellar' || parts[index + 1] !== FORMULA_NAME) continue;
    const cellarVersion = parts[index + 2];
    if (!cellarVersion) continue;
    const cellarRoot = parts.slice(0, index + 3).join(path.sep) || path.sep;
    return { formulaName: FORMULA_NAME, cellarVersion, cellarRoot };
  }
  return undefined;
}

function uniqueHomebrewSegments(paths: string[]) {
  const byKey = new Map<string, { formulaName: string; cellarVersion: string; cellarRoot: string }>();
  for (const candidate of paths) {
    const segment = extractHomebrewCellarPath(candidate);
    if (segment) byKey.set(`${segment.formulaName}:${segment.cellarVersion}:${segment.cellarRoot}`, segment);
  }
  return Array.from(byKey.values());
}

function isSemverLike(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isHeadVersion(value: string): boolean {
  return value === 'HEAD' || /^HEAD[-_][0-9A-Za-z.-]+$/.test(value);
}

function isDevCheckout(realPackageRoot: string): boolean {
  return fs.existsSync(path.join(realPackageRoot, '.git')) || fs.existsSync(path.join(path.dirname(realPackageRoot), '.git'));
}

function classifyInstallChannel(homebrewSegments: Array<{ formulaName: string; cellarVersion: string; cellarRoot: string }>, realPackageRoot: string, buildCommit?: string): { installChannel: InstallChannel; homebrew?: { formulaName: string; cellarVersion: string; cellarRoot: string } } {
  if (homebrewSegments.length === 0) {
    return { installChannel: isDevCheckout(realPackageRoot) ? 'dev' : 'unknown' };
  }

  const versions = new Set(homebrewSegments.map(segment => segment.cellarVersion));
  if (versions.size !== 1) return { installChannel: 'unsupported_channel' };

  const [homebrew] = homebrewSegments;
  if (isSemverLike(homebrew.cellarVersion)) return { installChannel: 'stable', homebrew };
  if (isHeadVersion(homebrew.cellarVersion)) {
    return { installChannel: buildCommit ? 'head' : 'unknown', homebrew };
  }
  return { installChannel: 'unsupported_channel', homebrew };
}

export function readBuildIdentity(options: BuildIdentityOptions = {}): BuildIdentity {
  const packageRoot = path.resolve(options.packageRoot ?? findPackageRoot());
  const realPackageRoot = safeRealpath(packageRoot);
  const executablePath = path.resolve(options.executablePath ?? process.argv[1] ?? process.execPath);
  const realExecutablePath = safeRealpath(executablePath);
  const packageJson = readJsonFile<PackageJson>(path.join(realPackageRoot, 'package.json'))
    ?? readJsonFile<PackageJson>(path.join(packageRoot, 'package.json'))
    ?? {};
  const metadata = readBuildMetadata(realPackageRoot, options.buildMetadataPath);
  const buildCommit = extractBuildCommit(metadata);
  const homebrewSegments = uniqueHomebrewSegments([executablePath, realExecutablePath, packageRoot, realPackageRoot]);
  const classification = classifyInstallChannel(homebrewSegments, realPackageRoot, buildCommit);
  const metadataSources = ['package_json'];
  if (metadata) metadataSources.push('build_metadata');

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    buildCommit,
    formulaName: classification.homebrew?.formulaName,
    installChannel: classification.installChannel,
    metadataSource: metadataSources.join('+'),
    pathEvidence: {
      executablePath,
      realExecutablePath,
      packageRoot,
      realPackageRoot
    },
    homebrew: classification.homebrew
  };
}

function parseSemver(value: string): [number, number, number, string] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}

function compareVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] !== parsedRight[index]) return parsedLeft[index] > parsedRight[index] ? 1 : -1;
  }
  return parsedLeft[3].localeCompare(parsedRight[3]);
}

function topLevelFormulaStanzas(formula: string): string {
  const kept: string[] = [];
  let skippedDepth = 0;
  for (const line of formula.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (skippedDepth > 0) {
      if (/\bdo\b/.test(trimmed)) skippedDepth += 1;
      if (/^end\b/.test(trimmed)) skippedDepth -= 1;
      continue;
    }
    if (/^(?:resource\s+["']|test\s+do\b|bottle\s+do\b)/.test(trimmed)) {
      if (/\bdo\b/.test(trimmed)) skippedDepth = 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

export function parseStableFormulaVersion(formula: string): string | undefined {
  const stableFormula = topLevelFormulaStanzas(formula);
  const explicitVersion = stableFormula.match(/^\s*version\s+"([^"]+)"/m)?.[1];
  if (explicitVersion) return explicitVersion.replace(/^v/, '');
  const url = stableFormula.match(/^\s*url\s+"([^"]+)"/m)?.[1];
  if (!url) return undefined;
  return url.match(/\/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.tar\.gz(?:$|[?#])/)?.[1]
    ?? url.match(/\/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\.zip|$|[?#])/)?.[1];
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
}

async function fetchText(url: string, options: UpdateCheckOptions): Promise<string> {
  const timeout = withTimeout(options.timeoutMs ?? 5000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: timeout.signal,
      headers: { 'user-agent': 'plan-reviewer-update-check' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    timeout.cancel();
  }
}

function stableUpdateCommand(): string {
  return `brew update && brew upgrade ${TAP_FORMULA}`;
}

function headUpdateCommand(): string {
  return `brew update && brew upgrade --fetch-HEAD ${TAP_FORMULA}`;
}

function restartCommand(): string {
  return 'brew services restart plan-reviewer';
}

function verifyCommand(): string {
  return 'plan-review --version && curl -fsS http://127.0.0.1:4317/health';
}

function updateAvailableStatus(current: BuildIdentity, latest: UpdateStatus['latest'], updateCommand: string): UpdateStatus {
  const latestLabel = latest?.version ?? latest?.commit ?? 'latest';
  const currentLabel = current.installChannel === 'head' ? current.buildCommit ?? current.packageVersion ?? 'unknown' : current.homebrew?.cellarVersion ?? current.packageVersion ?? 'unknown';
  return {
    status: 'update_available',
    checkedAt: new Date().toISOString(),
    current,
    latest,
    updateCommand,
    restartCommand: restartCommand(),
    verifyCommand: verifyCommand(),
    nextAction: `Run ${updateCommand}, then run ${restartCommand()} if this service is Homebrew-managed, and verify with ${verifyCommand()}. Current ${current.installChannel} build ${currentLabel} is behind ${latestLabel}.`
  };
}

function upToDateStatus(current: BuildIdentity, latest: UpdateStatus['latest']): UpdateStatus {
  return {
    status: 'up_to_date',
    checkedAt: new Date().toISOString(),
    current,
    latest,
    nextAction: 'No Homebrew-installable plan-reviewer update is available for the detected install channel.'
  };
}

function unknownStatus(current: BuildIdentity, status: Extract<UpdateStatusCode, 'unknown' | 'unsupported_channel'>, detail: string): UpdateStatus {
  return {
    status,
    checkedAt: new Date().toISOString(),
    current,
    nextAction: `${detail} Reinstall through Homebrew for managed update checks, or run plan-review update check from a supported Homebrew stable or --HEAD install.`
  };
}

function failedStatus(current: BuildIdentity, error: unknown): UpdateStatus {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'check_failed',
    checkedAt: new Date().toISOString(),
    current,
    error: message,
    nextAction: `Update metadata could not be reached (${message}). Retry with plan-review update check --json, or verify network access to the configured metadata endpoint.`
  };
}

async function checkStable(current: BuildIdentity, options: UpdateCheckOptions): Promise<UpdateStatus> {
  try {
    const formula = await fetchText(options.stableFormulaUrl ?? DEFAULT_STABLE_FORMULA_URL, options);
    const latestVersion = parseStableFormulaVersion(formula);
    if (!latestVersion) throw new Error('stable formula version not found');
    const latest = { version: latestVersion, source: 'homebrew_formula' };
    const currentVersion = current.homebrew?.cellarVersion ?? current.packageVersion;
    if (!currentVersion) return unknownStatus(current, 'unknown', 'The stable Homebrew install did not expose a current Homebrew Cellar or package version.');
    return compareVersions(latestVersion, currentVersion) > 0
      ? updateAvailableStatus(current, latest, stableUpdateCommand())
      : upToDateStatus(current, latest);
  } catch (error) {
    return failedStatus(current, error);
  }
}

function headCompareUrl(template: string, commit: string): string {
  return template.includes('{commit}') ? template.replaceAll('{commit}', encodeURIComponent(commit)) : template;
}

async function checkHead(current: BuildIdentity, options: UpdateCheckOptions): Promise<UpdateStatus> {
  if (!current.buildCommit) {
    return unknownStatus(current, 'unsupported_channel', 'The HEAD-shaped Homebrew install does not include a build commit, so plan-reviewer cannot compare it safely.');
  }
  try {
    const body = await fetchText(headCompareUrl(options.headCompareUrl ?? DEFAULT_HEAD_COMPARE_URL, current.buildCommit), options);
    const compare = JSON.parse(body) as { status?: string; ahead_by?: number; commits?: Array<{ sha?: string }> };
    if (compare.status === 'ahead' && (compare.ahead_by ?? 0) > 0) {
      const latestCommit = compare.commits?.at(-1)?.sha;
      return updateAvailableStatus(current, { commit: latestCommit, source: 'github_compare' }, headUpdateCommand());
    }
    if (compare.status === 'identical' || (compare.status === 'ahead' && (compare.ahead_by ?? 0) === 0)) {
      return upToDateStatus(current, { commit: current.buildCommit, source: 'github_compare' });
    }
    if (compare.status === 'behind' || compare.status === 'diverged') {
      return unknownStatus(current, 'unsupported_channel', 'The installed HEAD commit is not behind the tracked upstream branch.');
    }
    throw new Error(`unexpected compare status ${compare.status ?? 'missing'}`);
  } catch (error) {
    return failedStatus(current, error);
  }
}

export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const current = options.identity ?? readBuildIdentity(options.identityOptions);
  if (current.installChannel === 'stable') return checkStable(current, options);
  if (current.installChannel === 'head') return checkHead(current, options);
  if (current.installChannel === 'unsupported_channel') {
    return unknownStatus(current, 'unsupported_channel', 'The local install path looks Homebrew-managed but does not match a supported stable or HEAD shape.');
  }
  return unknownStatus(current, 'unknown', current.installChannel === 'dev'
    ? 'This looks like a development checkout, not a Homebrew-managed install.'
    : 'The local install path does not provide enough Homebrew evidence to choose an update channel.');
}

export function formatUpdateStatus(status: UpdateStatus): string {
  if (status.status === 'update_available') {
    const latest = status.latest?.version ?? status.latest?.commit ?? 'latest';
    const current = status.current.installChannel === 'head'
      ? status.current.buildCommit ?? status.current.packageVersion ?? 'unknown'
      : status.current.homebrew?.cellarVersion ?? status.current.packageVersion ?? status.current.buildCommit ?? 'unknown';
    return [
      `Update available: ${status.current.installChannel} ${current} → ${latest}`,
      `Command: ${status.updateCommand}`,
      `Restart if managed by brew services: ${status.restartCommand}`,
      `Verify: ${status.verifyCommand}`
    ].join('\n');
  }
  if (status.status === 'up_to_date') return `plan-reviewer is up to date for the ${status.current.installChannel} channel.`;
  if (status.status === 'check_failed') return `Update check failed: ${status.error}\nNEXT: ${status.nextAction}`;
  return `Update status: ${status.status}\nNEXT: ${status.nextAction}`;
}
