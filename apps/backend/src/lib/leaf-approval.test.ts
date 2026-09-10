import { describe, it, expect, vi } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { requestApproval, waitForApprovalDecision } from './leaf-approval.js';

async function seeded() {
  const db = new MemoryDB();
  await db.init();
  return db;
}

describe('requestApproval', () => {
  it('writes a pending row', async () => {
    const db = await seeded();
    await requestApproval(db, { id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'rm -rf /' });

    const [row] = await db.getPendingApprovals();
    expect(row).toMatchObject({ id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'rm -rf /', status: 'pending' });
    expect(row!.createdAt).toBeTruthy();
  });
});

describe('waitForApprovalDecision', () => {
  it('resolves approved as soon as the row flips, and cleans it up', async () => {
    const db = await seeded();
    await requestApproval(db, { id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'ls' });

    let polls = 0;
    const sleep = vi.fn(async () => {
      polls += 1;
      if (polls === 2) {
        const [row] = await db.getPendingApprovals();
        await db.savePendingApproval({ ...row!, status: 'approved', decidedAt: new Date().toISOString() });
      }
    });

    const outcome = await waitForApprovalDecision(db, 'a1', { sleep, pollIntervalMs: 1 });
    expect(outcome).toBe('approved');
    expect(await db.getPendingApprovals()).toHaveLength(0);
  });

  it('resolves denied when the row is explicitly denied', async () => {
    const db = await seeded();
    await requestApproval(db, { id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'ls' });

    const sleep = vi.fn(async () => {
      const [row] = await db.getPendingApprovals();
      await db.savePendingApproval({ ...row!, status: 'denied', decidedAt: new Date().toISOString() });
    });

    expect(await waitForApprovalDecision(db, 'a1', { sleep, pollIntervalMs: 1 })).toBe('denied');
  });

  it('times out and cleans up when no one decides in time', async () => {
    const db = await seeded();
    await requestApproval(db, { id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'ls' });

    let now = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    const outcome = await waitForApprovalDecision(db, 'a1', { sleep, pollIntervalMs: 1000, maxWaitMs: 2000 });
    expect(outcome).toBe('timed-out');
    expect(await db.getPendingApprovals()).toHaveLength(0);

    vi.spyOn(Date, 'now').mockImplementation(realNow);
  });

  it('heartbeats on every poll so a slow decision does not silently kill the activity', async () => {
    const db = await seeded();
    await requestApproval(db, { id: 'a1', ownerId: 'u1', leafId: 'leaf-1', command: 'ls' });

    const onHeartbeat = vi.fn();
    const sleep = vi.fn(async () => {
      if (onHeartbeat.mock.calls.length >= 3) {
        const [row] = await db.getPendingApprovals();
        await db.savePendingApproval({ ...row!, status: 'approved' });
      }
    });

    await waitForApprovalDecision(db, 'a1', { sleep, pollIntervalMs: 1, onHeartbeat });
    expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onHeartbeat).toHaveBeenCalledWith({ phase: 'awaiting-approval', approvalId: 'a1' });
  });

  it('treats a vanished row as denied rather than hanging', async () => {
    const db = await seeded();
    const outcome = await waitForApprovalDecision(db, 'never-requested', {});
    expect(outcome).toBe('denied');
  });
});
