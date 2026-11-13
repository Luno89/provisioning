import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { PoisoningSignal } from '../../engine/lib/poisoning.js';
import { PoisoningWatch, type PoisoningWatchDeps } from './poisoning-watch.js';
import type { ToolCallArgs } from '../temporal/contracts.js';

const call = (name: string): ToolCallArgs => ({
  ticket: { runId: 'run-1', depth: 0, ownerId: 'owner', agentSlug: 'koala', trigger: 'user', grantId: 'grant-1' },
  nodeId: 'tools',
  name,
  arguments: '{}',
});

function failingWatch() {
  const store = mock<PoisoningWatchDeps['store']>();
  store.openRunReads.mockRejectedValue(new Error('the database is not answering'));
  const saved: PoisoningSignal[] = [];
  store.savePoisoningSignal.mockImplementation(async (signal) => { saved.push(signal); return true; });
  const watch = new PoisoningWatch({ store, personText: async () => '', seal: (text) => text, now: () => '2026-11-13T10:00:00.000Z', log: () => undefined });
  return { watch, saved };
}

describe('the poisoning watch when it cannot check a call', () => {
  it('lets the call go on and records that it could not check it, as a signal the person sees', async () => {
    const { watch, saved } = failingWatch();
    await expect(watch.beforeCall(call('fetch_web_page'), {}, false)).resolves.toBeUndefined();
    expect(saved).toEqual([objectWith({ kind: 'unchecked', severity: 'medium', state: 'open', ownerId: 'owner', runId: 'run-1', tool: 'fetch_web_page', said: 'could not check fetch_web_page for poisoning: the database is not answering' })]);
  });

  it('records not keeping what a call read apart from not checking one', async () => {
    const { watch, saved } = failingWatch();
    await watch.beforeCall(call('fetch_web_page'), {}, false);
    await watch.afterCall(call('read_stored_file'), {}, 'file', { ok: true, digest: 'x' }, 0);
    expect(saved.map((signal) => signal.said)).toEqual([
      'could not check fetch_web_page for poisoning: the database is not answering',
      'could not keep what read_stored_file read, so later calls in this run are checked without it: the database is not answering',
    ]);
    expect(new Set(saved.map((signal) => signal.id)).size).toBe(2);
  });
});
