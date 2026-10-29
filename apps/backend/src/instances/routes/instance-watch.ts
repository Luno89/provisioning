import { Router, type Request, type Response } from 'express';
import { asyncRoute, authorize, principalFrom } from '../../platform/index.js';
import { RootRefused } from '../services/InstanceTrial.js';
import type { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';

const refused = (res: Response, err: unknown) =>
  res.status(err instanceof RootRefused ? err.status : 502).json({ error: (err as Error).message });

export function instanceWatchRouter(deps: { setting: Pick<InstanceWatchSetting, 'read' | 'set'> | undefined }): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.setting) return res.status(404).json({ error: 'only an instance is watched by root' });
    return deps.setting.read().then((view) => res.json(view), (err) => refused(res, err));
  }));

  router.put('/', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.setting) return res.status(404).json({ error: 'only an instance is watched by root' });
    const decision = authorize(principalFrom(req), 'change', { kind: 'instance-settings' });
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
    const on = ((req.body ?? {}) as { notifyWhenUnreachable?: unknown }).notifyWhenUnreachable;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'send notifyWhenUnreachable as true or false' });
    return deps.setting.set(on).then((view) => res.json(view), (err) => refused(res, err));
  }));

  return router;
}
