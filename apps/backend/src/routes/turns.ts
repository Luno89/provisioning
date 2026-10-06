import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { TurnLogEntry } from '../lib/turn-log.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

/** A turn's log, read from after a position: how a browser catches up before it follows the turn live. */
export function turnsRouter(deps: { log: { read(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]> } }): Router {
  const router = Router();

  router.get('/:turnId', asyncRoute(async (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) return res.status(400).json({ error: 'after is a position in the log: a whole number, 0 or more' });
    const entries = await deps.log.read(userOf(req).id, String(req.params.turnId ?? ''), after);
    res.json({ entries: entries.map(({ ownerId: _ownerId, ...entry }) => entry) });
  }));

  return router;
}
