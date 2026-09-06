import { describe, it, expect, vi } from 'vitest';
import { recordLeafFailure, notifyLeafFailure, retryDecisionFor } from './leaf-run-failure.js';
import type { Leaf } from './leaves.js';

const leaf: Leaf = {
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', column: 'todo', status: 'running',
  depth: 0, blocking: true, createdAt: '', updatedAt: '',
};

describe('recordLeafFailure', () => {
  it('appends the new attempt to prior ones and saves the leaf', async () => {
    const db = { saveLeaf: vi.fn(async () => undefined) };
    const out = await recordLeafFailure({ db, currentLeaf: async () => leaf }, {
      attemptNumber: 2, priorFailures: [{ attempt: 0, error: 'first', failedAt: '2026-01-01T00:00:00.000Z' }],
      errMessage: 'second failure', produced: false, diagnosis: undefined, secretsInPlay: () => [],
    });

    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[1]).toMatchObject({ attempt: 1, error: 'second failure', produced: false });
    expect(db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });

  it('marks the leaf failed once attempts are exhausted', async () => {
    const db = { saveLeaf: vi.fn(async () => undefined) };
    await recordLeafFailure({ db, currentLeaf: async () => leaf }, {
      attemptNumber: 3, priorFailures: [], errMessage: 'x', produced: false, diagnosis: undefined, secretsInPlay: () => [],
    });
    expect(db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('redacts secrets out of the recorded error and diagnosis', async () => {
    const db = { saveLeaf: vi.fn(async () => undefined) };
    const out = await recordLeafFailure({ db, currentLeaf: async () => leaf }, {
      attemptNumber: 1, priorFailures: [], errMessage: 'token sk-secret123 leaked', produced: false,
      diagnosis: 'used sk-secret123 in a request', secretsInPlay: () => ['sk-secret123'],
    });
    expect(out.attempts[0]!.error).not.toContain('sk-secret123');
  });

  it('saves nothing when the leaf no longer exists', async () => {
    const db = { saveLeaf: vi.fn(async () => undefined) };
    await recordLeafFailure({ db, currentLeaf: async () => undefined }, {
      attemptNumber: 1, priorFailures: [], errMessage: 'x', produced: false, diagnosis: undefined, secretsInPlay: () => [],
    });
    expect(db.saveLeaf).not.toHaveBeenCalled();
  });
});

describe('notifyLeafFailure', () => {
  it('posts a failure notice to the branch', async () => {
    const branch = { id: 'b1', ownerId: 'u1', title: 'Branch', messages: [], createdAt: '', updatedAt: '' };
    const db = { getBranches: vi.fn(async () => [branch]), saveBranch: vi.fn(async () => undefined) };
    await notifyLeafFailure({ db }, { leafId: 'l1', branchId: 'b1', leafTitle: 't', errMessage: 'boom', attemptCount: 1 });
    expect(db.saveBranch).toHaveBeenCalled();
  });

  it('does nothing when the branch no longer exists', async () => {
    const db = { getBranches: vi.fn(async () => []), saveBranch: vi.fn(async () => undefined) };
    await notifyLeafFailure({ db }, { leafId: 'l1', branchId: 'gone', leafTitle: 't', errMessage: 'boom', attemptCount: 1 });
    expect(db.saveBranch).not.toHaveBeenCalled();
  });

  it('swallows its own failure rather than propagating it', async () => {
    const db = { getBranches: vi.fn(async () => { throw new Error('db down'); }), saveBranch: vi.fn() };
    await expect(notifyLeafFailure({ db }, {
      leafId: 'l1', branchId: 'b1', leafTitle: 't', errMessage: 'boom', attemptCount: 1,
    })).resolves.toBeUndefined();
  });
});

describe('retryDecisionFor', () => {
  it('retries a plain failure', () => {
    expect(retryDecisionFor({ errMessage: 'x', selfDiagnosed: undefined, produced: true, priorFailures: [] }))
      .toEqual({ kind: 'retry' });
  });

  it('stops non-retryably when the run diagnosed itself as circling', () => {
    const out = retryDecisionFor({ errMessage: 'x', selfDiagnosed: 'circling', produced: false, priorFailures: [] });
    expect(out).toMatchObject({ kind: 'nonRetryable', type: 'SelfDiagnosedStop' });
    expect((out as any).message).toContain('going in circles');
  });

  it('describes thrashing and silence with their own wording', () => {
    expect((retryDecisionFor({ errMessage: 'x', selfDiagnosed: 'thrashing', produced: false, priorFailures: [] }) as any).message)
      .toContain('producing nothing');
    expect((retryDecisionFor({ errMessage: 'x', selfDiagnosed: 'silent', produced: false, priorFailures: [] }) as any).message)
      .toContain('stopped calling tools');
  });

  it('stops non-retryably after two barren attempts', () => {
    const out = retryDecisionFor({
      errMessage: 'x', selfDiagnosed: undefined, produced: false,
      priorFailures: [{ attempt: 0, error: 'e', failedAt: '', produced: false }],
    });
    expect(out).toMatchObject({ kind: 'nonRetryable', type: 'NoProgress' });
  });

  it('keeps retrying a single barren attempt', () => {
    const out = retryDecisionFor({ errMessage: 'x', selfDiagnosed: undefined, produced: false, priorFailures: [] });
    expect(out).toEqual({ kind: 'retry' });
  });

  it('self-diagnosis takes priority over the barren-streak check', () => {
    const out = retryDecisionFor({
      errMessage: 'x', selfDiagnosed: 'circling', produced: false,
      priorFailures: [{ attempt: 0, error: 'e', failedAt: '', produced: false }],
    });
    expect(out).toMatchObject({ type: 'SelfDiagnosedStop' });
  });
});
