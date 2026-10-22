import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { isMovePart } from '../lib/instance-move.js';
import { volumeOfPart } from '../lib/app-move.js';
import type { MoveExport } from '../services/MoveExport.js';

const tokenOf = (req: Request): unknown => req.query.token;

export function moveRouter(deps: { move: MoveExport; log?: (message: string) => void }): Router {
  const router = Router();

  router.get('/parts/:part', asyncRoute(async (req: Request, res: Response) => {
    const part = String(req.params.part ?? '');
    const volume = volumeOfPart(part);
    if (!isMovePart(part) && !volume) return res.status(404).json({ error: 'that is not a part of an instance' });
    const refused = deps.move.check(tokenOf(req), part) ?? await deps.move.freeze();
    if (refused) return res.status(refused.status).json({ error: refused.error });
    let opened;
    try {
      opened = volume ? deps.move.volume(volume.namespace, volume.claim) : deps.move.open(part as Parameters<MoveExport['open']>[0]);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    res.setHeader('content-type', opened.type);
    res.setHeader('cache-control', 'no-store');
    opened.out.pipe(res);
    opened.done.catch((err: Error) => {
      deps.log?.(`[move] ${part} stopped part way: ${err.message}`);
      res.destroy(err);
    });
    return undefined;
  }));

  router.post('/thaw', asyncRoute(async (req: Request, res: Response) => {
    const refused = deps.move.check(tokenOf(req), 'thaw');
    if (refused) return res.status(refused.status).json({ error: refused.error });
    await deps.move.thaw();
    return res.json({ thawed: true });
  }));

  return router;
}
