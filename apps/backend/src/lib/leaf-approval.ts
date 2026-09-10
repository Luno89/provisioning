import type { Database } from './db-interface.js';

export const APPROVAL_POLL_INTERVAL_MS = 3_000;
export const APPROVAL_MAX_WAIT_MS = 30 * 60_000;

export async function requestApproval(
  db: Pick<Database, 'savePendingApproval'>,
  approval: { id: string; ownerId: string; leafId: string; projectId?: string; command: string },
): Promise<void> {
  await db.savePendingApproval({
    ...approval,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
}

export type ApprovalOutcome = 'approved' | 'denied' | 'timed-out';

export async function waitForApprovalDecision(
  db: Pick<Database, 'getPendingApprovals' | 'deletePendingApproval'>,
  approvalId: string,
  opts: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
    onHeartbeat?: ((note: Record<string, unknown>) => void) | undefined;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ApprovalOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? APPROVAL_MAX_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    opts.onHeartbeat?.({ phase: 'awaiting-approval', approvalId });

    const row = (await db.getPendingApprovals()).find((a) => a.id === approvalId);
    if (!row) return 'denied';
    if (row.status !== 'pending') {
      await db.deletePendingApproval(approvalId).catch(() => undefined);
      return row.status === 'approved' ? 'approved' : 'denied';
    }
    if (Date.now() >= deadline) {
      await db.deletePendingApproval(approvalId).catch(() => undefined);
      return 'timed-out';
    }
    await sleep(pollIntervalMs);
  }
}
