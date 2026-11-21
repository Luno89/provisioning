import { Router, type Request, type Response } from 'express';
import { asyncRoute, type OpenRoute } from '../../platform/index.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';

export interface MachineCaller {
  ownerId: string;
}

export const ACCOUNT_MACHINES_OPEN: readonly OpenRoute[] = ['/', '/join-code', '/adopt', '/:id'];

export function accountMachinesRouter(deps: {
  accounts: Pick<MachineAccounts, 'list' | 'createJoinCode' | 'remove' | 'adoptFrom'>;
  callerOf: (req: Request) => Promise<MachineCaller | undefined>;
}): Router {
  const router = Router();
  const owner = async (req: Request, res: Response): Promise<string | undefined> => {
    const caller = await deps.callerOf(req);
    if (!caller) res.status(401).json({ error: 'unknown instance or credential' });
    return caller?.ownerId;
  };

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await owner(req, res);
    if (ownerId) res.json(await deps.accounts.list(ownerId));
  }));

  router.post('/join-code', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await owner(req, res);
    if (!ownerId) return;
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await deps.accounts.createJoinCode(ownerId));
  }));

  router.post('/adopt', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await owner(req, res);
    if (ownerId) res.json(await deps.accounts.adoptFrom(ownerId, (req.body as { machines?: unknown } | undefined)?.machines));
  }));

  router.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await owner(req, res);
    if (!ownerId) return;
    if (!(await deps.accounts.remove(ownerId, String(req.params.id ?? '')))) return res.status(404).json({ error: 'no such machine' });
    res.json({ success: true });
  }));

  return router;
}
