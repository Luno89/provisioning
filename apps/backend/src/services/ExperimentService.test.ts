import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { ExperimentService } from './ExperimentService.js';
import type { Experiment } from '../lib/experiments.js';

/**
 * Reconciliation, which is the part that can destroy work rather than merely mis-report it.
 *
 * The case these exist for was found by running the Lab for real: an edit to a source file
 * restarted the backend under `tsx watch`, bootstrap reconciled an experiment that a SEPARATE
 * process was three minutes into, and the run died with a sandbox orphaned behind it. Absence from
 * this process's memory is not evidence that the work is dead.
 */
const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'e1',
  ownerId: 'u1',
  name: 'suite',
  tasks: [{ id: 't1', name: 'fib', prompt: 'do it', verifyCommand: 'node t.js' }],
  language: 'node',
  variants: [{ label: 'a', overrides: {} }, { label: 'b', overrides: {} }],
  repeats: 1,
  status: 'running',
  results: [],
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: new Date().toISOString(),
  ...over,
});

const serviceWith = async (...records: Experiment[]) => {
  const db = new MemoryDB();
  await db.init();
  for (const r of records) await db.saveExperiment(r);
  // ModelService is never reached: nothing here starts a run.
  return { db, svc: new ExperimentService(db, {} as any) };
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('reconcileInterrupted', () => {
  it('leaves a run alone while something is still updating it', async () => {
    // The regression. A second process — lab-live.mts, a replica, an in-cluster runner — owns this
    // run, and reaping it strands the sandbox it is using mid-variant.
    const { db, svc } = await serviceWith(experiment({ updatedAt: minutesAgo(1) }));

    expect(await svc.reconcileInterrupted()).toBe(0);
    expect((await db.getExperiments())[0]!.status).toBe('running');
  });

  it('closes out a run nothing has touched for long enough to be dead', async () => {
    const { db, svc } = await serviceWith(experiment({ updatedAt: minutesAgo(30) }));

    expect(await svc.reconcileInterrupted()).toBe(1);
    const [after] = await db.getExperiments();
    expect(after!.status).toBe('failed');
    expect(after!.progress).toBeUndefined();
    expect(after!.error).toMatch(/0 of 2 runs/);
  });

  it('keeps the results a dead run already produced', async () => {
    // Each variant was saved as it landed. They are real measurements someone paid GPU time for,
    // and the record going terminal is no reason to discard them.
    const done = {
      label: 'a', taskId: 't1', succeeded: true, verified: true, verifyExitCode: 0,
      verifyOutput: 'PASS', steps: 4, tokensUsed: 900, durationMs: 1000, summary: 'ok',
      transcript: [],
    };
    const { db, svc } = await serviceWith(experiment({ updatedAt: minutesAgo(30), results: [done] }));

    await svc.reconcileInterrupted();
    const [after] = await db.getExperiments();
    expect(after!.results).toHaveLength(1);
    expect(after!.error).toMatch(/1 of 2 runs/);
  });

  it('treats a record that cannot say when it last moved as dead', async () => {
    const { db, svc } = await serviceWith(experiment({ updatedAt: 'not a date' }));

    expect(await svc.reconcileInterrupted()).toBe(1);
    expect((await db.getExperiments())[0]!.status).toBe('failed');
  });

  it('ignores experiments that already finished', async () => {
    const { db, svc } = await serviceWith(
      experiment({ id: 'done', status: 'complete', updatedAt: minutesAgo(90) }),
      experiment({ id: 'draft', status: 'draft', updatedAt: minutesAgo(90) }),
    );

    expect(await svc.reconcileInterrupted()).toBe(0);
    expect((await db.getExperiments()).map((e) => e.status).sort()).toEqual(['complete', 'draft']);
  });
});
