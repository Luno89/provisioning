import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

const nameIn = (body: unknown, field: string): string | undefined => {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export interface KoalaWhere { machineId?: string | undefined; status?: string | undefined }

export function myMachinesRouter(deps: {
  accounts: Pick<MachineAccounts, 'listOnline' | 'createJoinCode' | 'putKoalaOn' | 'remove'>;
  koalaOf: (ownerId: string) => Promise<KoalaWhere | undefined>;
}): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    const owner = userOf(req).id;
    const [machines, koala] = await Promise.all([deps.accounts.listOnline(owner), deps.koalaOf(owner)]);
    res.json({ machines: machines.map((machine) => ({ ...machine, holdsKoala: koala?.machineId === machine.id })), koala: koala ?? null });
  }));

  router.post('/join-code', asyncRoute(async (req: Request, res: Response) => {
    res.status(201).json(await deps.accounts.createJoinCode(userOf(req).id, nameIn(req.body, 'koalaName')));
  }));

  router.post('/:id/koala', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.accounts.putKoalaOn(userOf(req).id, param(req, 'id'), nameIn(req.body, 'name'));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.status(202).json(outcome.value);
  }));

  router.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.accounts.remove(userOf(req).id, param(req, 'id')))) return res.status(404).json({ error: 'no such machine on your account' });
    res.json({ removed: true });
  }));

  return router;
}
