import { Router } from 'express';
import { allowed, asyncRoute, authorize, isOff, principalFrom, type Off } from '../../platform/index.js';
import { provisioningView } from '../lib/provisioning.js';
import type { Provisioning } from '../services/Provisioning.js';

export type SetupAction = 'set-up-again';

export interface ProvisioningRouterDeps {
  provisioning: Pick<Provisioning, 'latest' | 'again'> | Off;
}

export function provisioningRouter({ provisioning }: ProvisioningRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    if (isOff(provisioning)) return res.json({ setups: [], can: [], off: provisioning.off });
    const principal = principalFrom(req);
    const setups = (await provisioning.latest()).filter((record) => allowed(principal, 'see', { kind: 'record', noun: 'provisioning', ownerId: record.ownerId }));
    const can: SetupAction[] = allowed(principal, 'set-up-again', { kind: 'install' }) ? ['set-up-again'] : [];
    return res.json({ setups: setups.map(provisioningView), can });
  }));

  router.post('/again', asyncRoute(async (req, res) => {
    if (isOff(provisioning)) return res.status(409).json({ error: provisioning.off });
    const decision = authorize(principalFrom(req), 'set-up-again', { kind: 'install' });
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
    const clusterId = (req.body as { clusterId?: unknown } | undefined)?.clusterId;
    if (typeof clusterId !== 'string' || clusterId === '') return res.status(400).json({ error: 'name the cluster to set up again as "clusterId"' });
    const started = await provisioning.again(clusterId);
    if (!started) return res.status(404).json({ error: `Koala has set nothing up on ${clusterId}` });
    return res.status(202).json(provisioningView(started));
  }));

  return router;
}
