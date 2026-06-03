import fs from 'node:fs';
import path from 'node:path';
import { PlanReviewError } from '../util.js';

export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new PlanReviewError('network_error', `Unable to reach ${url}`, 503, {
      cause: error instanceof Error ? error.message : String(error)
    }, 'Start plan-reviewer or pass --url / PLAN_REVIEW_URL for the running service.');
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new PlanReviewError('network_error', `Failed reading response from ${url}`, response.status, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new PlanReviewError('invalid_json', `Expected JSON from ${url}`, response.status, { bodyPreview: text.slice(0, 240) });
  }
  if (!response.ok || json.ok === false) {
    const error = json.error ?? {};
    throw new PlanReviewError(error.code ?? 'api_error', error.message ?? `Request failed: ${response.status}`, response.status, error.details, error.nextAction);
  }
  return (json.data ?? json) as T;
}

export function appendNdjson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}
