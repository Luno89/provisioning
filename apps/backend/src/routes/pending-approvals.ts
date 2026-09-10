import { Router, type Request } from 'express';
import type { Database } from '../lib/db-interface.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function pendingApprovalsRouter(deps: { db: Database }): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const mine = (await db.getPendingApprovals())
      .filter((a) => a.ownerId === userOf(req).id && a.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json(mine);
  });

  router.post('/:id/decide', async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      return res.status(400).json({ error: 'decision must be "approved" or "denied"' });
    }

    const row = (await db.getPendingApprovals())
      .find((a) => a.id === req.params.id && a.ownerId === userOf(req).id);
    if (!row) return res.status(404).json({ error: 'Approval not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'Already decided' });

    await db.savePendingApproval({ ...row, status: decision, decidedAt: new Date().toISOString() });
    res.json({ success: true });
  });

  return router;
}
