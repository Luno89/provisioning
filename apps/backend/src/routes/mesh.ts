import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { isMeshAddress } from '../lib/endpoint-url-safety.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function meshRouter(deps: Record<string, any>): Router {
  const { headscaleService, db, jwtSecret } = deps;
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
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  router.post('/preauth-key', async (req, res) => {
    try {
      const reusable = req.body?.reusable === true;
      const expirySeconds = typeof req.body?.expirySeconds === 'number' ? req.body.expirySeconds : undefined;
      const key = await headscaleService.createPreAuthKey(userOf(req).id, { reusable, expirySeconds });
      res.status(201).json(key);
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  router.delete('/devices/:nodeId', async (req, res) => {
    try {
      const devices = await headscaleService.listUserDevices(userOf(req).id);
      if (!devices.some((d: any) => d.id === req.params.nodeId)) {
        return res.status(404).json({ error: 'Mesh device not found' });
      }
      await headscaleService.revokeDevice(req.params.nodeId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  return router;
}
