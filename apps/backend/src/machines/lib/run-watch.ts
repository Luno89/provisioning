export type RunLife = 'running' | 'ended' | 'not-theirs';

const RUN_ID = /^[A-Za-z0-9._~:@-]{1,300}$/;
const MOST_RUNS = 200;

export function runIdsFrom(raw: unknown): string[] {
  const listed = raw && typeof raw === 'object' ? (raw as { runIds?: unknown }).runIds : undefined;
  if (!Array.isArray(listed)) return [];
  return [...new Set(listed.filter((runId): runId is string => typeof runId === 'string' && RUN_ID.test(runId)))].slice(0, MOST_RUNS);
}
