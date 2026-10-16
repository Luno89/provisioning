import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { joinEnv } from '../lib/machines.js';
import type { MachineService } from '../services/MachineService.js';

export function machinesRouter(deps: { machines: Pick<MachineService, 'join'>; bundle: () => Promise<string> }): Router {
  const router = Router();

  router.post('/join', asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { code?: unknown; hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown };
    const outcome = await deps.machines.join(body.code, { hostname: body.hostname, rootDir: body.rootDir, os: body.os, replaces: body.replaces });
    if (!outcome.ok) return res.status(outcome.status).type('text/plain').send(outcome.error);
    if (req.query.format === 'env') return res.type('text/plain').send(joinEnv(outcome.value.env));
    res.json(outcome.value);
  }));

  router.get('/agent.tgz', asyncRoute(async (_req: Request, res: Response) => {
    res.type('application/gzip').sendFile(await deps.bundle());
  }));

  return router;
}
