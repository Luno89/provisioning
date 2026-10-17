import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { InstanceAddresses } from '../services/InstanceAddresses.js';

const NONE = 'this instance has no addresses of its own: it was installed without a domain from root';

export function instanceAddressesRouter(deps: { addresses: () => Pick<InstanceAddresses, 'refresh' | 'set'> | undefined }): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req: Request, res: Response) => {
    const addresses = deps.addresses();
    if (!addresses) return res.status(404).json({ error: NONE });
    return res.json(await addresses.refresh());
  }));

  router.put('/', asyncRoute(async (req: Request, res: Response) => {
    const addresses = deps.addresses();
    if (!addresses) return res.status(404).json({ error: NONE });
    const nested = ((req.body ?? {}) as { nested?: unknown }).nested;
    if (typeof nested !== 'boolean') return res.status(400).json({ error: 'send "nested" as true or false' });
    return res.json(await addresses.set(nested));
  }));

  return router;
}
