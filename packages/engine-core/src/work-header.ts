import type { Payload } from '@temporalio/common';

export const WORK_HEADER = 'koala-work';

export interface WorkNamed {
  owner?: string | undefined;
  project?: string | undefined;
}

export const namedOnly = (work: WorkNamed): WorkNamed =>
  Object.fromEntries(Object.entries(work).filter(([, value]) => typeof value === 'string' && value)) as WorkNamed;

export const workPayload = (work: WorkNamed): Payload => ({
  metadata: { encoding: new TextEncoder().encode('json/plain') },
  data: new TextEncoder().encode(JSON.stringify(JSON.stringify(namedOnly(work)))),
});

export function workOfPayload(payload: Payload | undefined): WorkNamed | undefined {
  if (!payload?.data) return undefined;
  const text = JSON.parse(new TextDecoder().decode(payload.data)) as unknown;
  if (typeof text !== 'string') return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const work = namedOnly(parsed as WorkNamed);
  return Object.keys(work).length > 0 ? work : undefined;
}
