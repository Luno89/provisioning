import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { TurnLogEntry } from '../lib/turn-log.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

export const RECENT_TURNS_HOURS = 24;
export const RECENT_TURNS_SHOWN = 50;

export function turnsRouter(deps: {
  log: {
    read(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]>;
    recent(ownerId: string, since: string, limit: number): Promise<TurnLogEntry[]>;
  };
  now?: (() => Date) | undefined;
}): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const since = new Date((deps.now?.() ?? new Date()).getTime() - RECENT_TURNS_HOURS * 3_600_000).toISOString();
    const firsts = await deps.log.recent(userOf(req).id, since, RECENT_TURNS_SHOWN);
    res.json({
      turns: firsts.map((entry) => {
        const started = entry.events.find((event) => event.type === 'run.started' && event.runId === entry.turnId) as { agentId?: string } | undefined;
        return { turnId: entry.turnId, at: entry.at, ...(started?.agentId ? { agentId: started.agentId } : {}) };
      }),
    });
  }));

  router.get('/:turnId', asyncRoute(async (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) return res.status(400).json({ error: 'after is a position in the log: a whole number, 0 or more' });
    const entries = await deps.log.read(userOf(req).id, String(req.params.turnId ?? ''), after);
    res.json({ entries: entries.map(({ ownerId: _ownerId, ...entry }) => entry) });
  }));

  return router;
}
