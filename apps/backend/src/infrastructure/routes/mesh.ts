import { at } from '../../platform/index.js';
import { Router, type Request } from 'express';
import type { HeadscaleService } from '../services/HeadscaleService.js';

export interface MeshRouterDeps {
  headscaleService: Pick<HeadscaleService, 'listUserDevices' | 'createPreAuthKey' | 'revokeDevice'>;
}

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function meshRouter(deps: MeshRouterDeps): Router {
  const { headscaleService } = deps;
  const router = Router();

  router.get('/config', async (_req, res) => {
    const loginServer = process.env.MESH_LOGIN_SERVER || null;
    res.json({
      loginServer,
      configured: Boolean(loginServer && !/localhost|127\.0\.0\.1/.test(loginServer)),
    });
  });

  router.get('/devices', async (req, res) => {
    try {
      res.json(await headscaleService.listUserDevices(userOf(req).id));
    } catch (err) {
      res.status(503).json({ error: `Mesh unavailable: ${(err as Error).message}` });
    }
  });

  router.post('/preauth-key', async (req, res) => {
    try {
      const reusable = at(req.body, 'reusable') === true;
      const expirySeconds = at(req.body, 'expirySeconds');
      const key = await headscaleService.createPreAuthKey(userOf(req).id, { reusable, ...(typeof expirySeconds === 'number' ? { expirySeconds } : {}) });
      res.status(201).json(key);
    } catch (err) {
      res.status(503).json({ error: `Mesh unavailable: ${(err as Error).message}` });
    }
  });

  router.delete('/devices/:nodeId', async (req, res) => {
    try {
      const devices = await headscaleService.listUserDevices(userOf(req).id);
      if (!devices.some((d) => d.id === req.params.nodeId)) {
        return res.status(404).json({ error: 'Mesh device not found' });
      }
      await headscaleService.revokeDevice(req.params.nodeId);
      res.json({ success: true });
    } catch (err) {
      res.status(503).json({ error: `Mesh unavailable: ${(err as Error).message}` });
    }
  });

  return router;
}
