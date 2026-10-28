import { Router, type Request, type Response } from 'express';
import { asyncRoute, authorize, principalFrom } from '../../platform/index.js';

const notOwner = (req: Request, res: Response): boolean => {
  const decision = authorize(principalFrom(req), 'change', { kind: 'instance-settings' });
  if (decision.allowed) return false;
  res.status(decision.status).json({ error: decision.error });
  return true;
};
import { UpdatesRefused, type InstanceUpdates } from '../services/InstanceUpdates.js';

const NONE = 'this instance takes no updates from root: it was installed without a credential from root';

const refused = (res: Response, err: unknown) => {
  if (err instanceof UpdatesRefused) return res.status(err.status === 401 ? 502 : err.status).json({ error: err.message });
  throw err;
};

export function instanceUpdatesRouter(deps: { updates: Pick<InstanceUpdates, 'view' | 'set'> | undefined }): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.updates) return res.status(404).json({ error: NONE });
    try {
      return res.json(await deps.updates.view());
    } catch (err) {
      return refused(res, err);
    }
  }));

  router.put('/', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.updates) return res.status(404).json({ error: NONE });
    if (notOwner(req, res)) return;
    const { auto, version } = (req.body ?? {}) as { auto?: unknown; version?: unknown };
    if (auto !== undefined && typeof auto !== 'boolean') return res.status(400).json({ error: 'send "auto" as true or false' });
    if (version !== undefined && typeof version !== 'string') return res.status(400).json({ error: 'send "version" as the release to move to' });
    try {
      return res.json(await deps.updates.set({ ...(auto !== undefined ? { auto } : {}), ...(version !== undefined ? { version } : {}) }));
    } catch (err) {
      return refused(res, err);
    }
  }));

  return router;
}
