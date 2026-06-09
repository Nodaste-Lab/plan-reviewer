import { spawnSync } from 'node:child_process';
import { PlanReviewError } from './util.js';
import type { PlanPullRequest } from './schemas.js';

export interface GitHubRepoRef { owner: string; repo: string }
export interface GitHubPrLookupOptions { token?: string; fetchImpl?: typeof fetch; ghTokenCommand?: () => string | undefined }

export function parseGitHubPrUrl(url: string): { owner: string; repo: string; number: number; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidPrUrl(url);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw invalidPrUrl(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[2] !== 'pull' || !/^\d+$/.test(parts[3] ?? '')) throw invalidPrUrl(url);
  return {
    owner: parts[0]!,
    repo: parts[1]!,
    number: Number(parts[3]),
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${parts[3]}`
  };
}

function invalidPrUrl(url: string): PlanReviewError {
  return new PlanReviewError(
    'invalid_github_pr_url',
    'Expected a canonical GitHub PR URL: https://github.com/<owner>/<repo>/pull/<number>',
    1,
    { url },
    'Pass --url https://github.com/<owner>/<repo>/pull/<number>.'
  );
}

export function parseGitHubRemote(value: string | undefined): GitHubRepoRef | undefined {
  if (!value) return undefined;
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[?#].*)?$/.exec(value);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(value);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return undefined;
}

export function pullRequestStatus(pr: Pick<PlanPullRequest, 'state' | 'merged' | 'lastCheckedAt'>, now = new Date()): PlanPullRequest['status'] {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  const checked = pr.lastCheckedAt ? new Date(pr.lastCheckedAt) : undefined;
  const stale = !checked || Number.isNaN(checked.getTime()) || now.getTime() - checked.getTime() > 24 * 60 * 60 * 1000;
  if ((pr.state === 'open' || pr.state === 'unknown') && stale) return 'stale';
  return pr.state === 'open' ? 'open' : 'unknown';
}

function ghAuthToken(): string | undefined {
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function authToken(options: GitHubPrLookupOptions): string | undefined {
  return options.token ?? process.env.GITHUB_TOKEN ?? options.ghTokenCommand?.() ?? ghAuthToken();
}

async function githubJson<T>(url: string, options: GitHubPrLookupOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = authToken(options);
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'plan-reviewer' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new PlanReviewError(
      'github_lookup_failed',
      `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
      1,
      { url },
      'Check network access, set GITHUB_TOKEN, run gh auth login, or explicitly link the PR URL with plan-review pr link <plan> --url <github-pr-url>.'
    );
  }
  const text = await response.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch {}
  if (!response.ok) {
    const message = json?.message ? String(json.message) : `GitHub request failed with ${response.status}`;
    const nextAction = response.status === 401 || response.status === 403 || response.status === 404
      ? `Attempted ${url}. Set GITHUB_TOKEN, run gh auth login, or explicitly link a reachable PR URL with plan-review pr link <plan> --url <github-pr-url>.`
      : `Attempted ${url}. Retry later or explicitly link the PR URL if GitHub lookup is unavailable.`;
    throw new PlanReviewError('github_lookup_failed', message, 1, { url, status: response.status }, nextAction);
  }
  return json as T;
}

interface GitHubPrResponse {
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  merged_at?: string | null;
  head?: { ref?: string; repo?: { full_name?: string | null; owner?: { login?: string } | null } | null };
  base?: { ref?: string };
}

export function githubPrToMetadata(input: GitHubPrResponse, repo: GitHubRepoRef, source: PlanPullRequest['source'], now = new Date()): PlanPullRequest {
  const mergedAt = input.merged_at || undefined;
  return {
    provider: 'github',
    url: input.html_url,
    owner: repo.owner,
    repo: repo.repo,
    number: input.number,
    headRef: input.head?.ref ?? '',
    headRepo: input.head?.repo?.full_name ?? undefined,
    baseRef: input.base?.ref ?? '',
    state: input.state ?? 'unknown',
    merged: Boolean(mergedAt),
    mergedAt,
    lastCheckedAt: now.toISOString(),
    source,
    status: mergedAt ? 'merged' : input.state === 'closed' ? 'closed' : 'open'
  };
}

export async function fetchPullRequestByUrl(url: string, options: GitHubPrLookupOptions = {}): Promise<PlanPullRequest> {
  const parsed = parseGitHubPrUrl(url);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`;
  const data = await githubJson<GitHubPrResponse>(apiUrl, options);
  return githubPrToMetadata(data, parsed, 'explicit');
}

export async function discoverPullRequest(repo: GitHubRepoRef, branch: string, options: GitHubPrLookupOptions = {}, planIdentifier = '<plan>'): Promise<PlanPullRequest> {
  const params = new URLSearchParams({ state: 'all', head: `${repo.owner}:${branch}`, per_page: '10' });
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?${params}`;
  const data = await githubJson<GitHubPrResponse[]>(apiUrl, options);
  const matches = data.filter(item => item.head?.ref === branch && item.head?.repo?.full_name?.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase());
  if (matches.length === 0) {
    throw new PlanReviewError('github_pr_not_found', `No GitHub PR matched ${repo.owner}/${repo.repo} branch ${branch}`, 1, { repo, branch }, `Create or link explicitly: plan-review pr link ${planIdentifier} --url https://github.com/${repo.owner}/${repo.repo}/pull/<number>`);
  }
  if (matches.length > 1) {
    throw new PlanReviewError('github_pr_ambiguous', `Multiple GitHub PRs matched ${repo.owner}/${repo.repo} branch ${branch}`, 1, { repo, branch, matches: matches.map(item => item.html_url) }, `Choose one explicitly: plan-review pr link ${planIdentifier} --url https://github.com/${repo.owner}/${repo.repo}/pull/<number>`);
  }
  return githubPrToMetadata(matches[0]!, repo, 'auto-discovered');
}

export async function refreshPullRequest(current: PlanPullRequest, options: GitHubPrLookupOptions = {}): Promise<PlanPullRequest> {
  const refreshed = await fetchPullRequestByUrl(current.url, options);
  return { ...refreshed, source: current.source === 'auto-discovered' ? 'auto-discovered' : 'refreshed' };
}
