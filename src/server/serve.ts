import { createApp } from './app.js';

export async function serve(options: { host: string; port: number; dbPath: string }) {
  if (options.host === '0.0.0.0' || options.host === '::') {
    console.warn(`WARNING: plan-reviewer is listening on ${options.host}:${options.port} without authentication. Anyone who can reach this service can view and comment on plans.`);
  }
  const app = createApp({ dbPath: options.dbPath });
  await app.listen({ host: options.host, port: options.port });
  return app;
}
