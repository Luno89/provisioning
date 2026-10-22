import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import type { MachineService } from '../services/MachineService.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

export function localAgentsRouter(deps: { machines: Pick<MachineService, 'list' | 'createJoinCode' | 'setManualAgents' | 'installAdapter' | 'remove'> }): Router {
  const { machines } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json(await machines.list(userOf(req).id));
  }));

  router.post('/join-code', asyncRoute(async (req: Request, res: Response) => {
    res.status(201).json(await machines.createJoinCode(userOf(req).id));
  }));

  router.put('/:id/agents', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await machines.setManualAgents(userOf(req).id, param(req, 'id'), req.body?.agents);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.post('/:id/agents/:agentId/install', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await machines.installAdapter(userOf(req).id, param(req, 'id'), param(req, 'agentId'));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
    if (!(await machines.remove(userOf(req).id, param(req, 'id')))) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  }));

  return router;
}
