import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { isMeshAddress } from '../lib/endpoint-url-safety.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The Headscale mesh: which machines have joined, and the pre-auth keys that let them.
 */
export function meshRouter(deps: Record<string, any>): Router {
  const { headscaleService, db, jwtSecret } = deps;
  const router = Router();

  /**
   * What the UI needs to render a working join command, plus whether the mesh is usable at all.
   * `loginServer` is null on a local dev box (MESH_LOGIN_SERVER unset, Headscale's server_url
   * still localhost) — the UI must say so rather than printing a command that would tell the
   * user's machine to contact itself.
   */
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
      // Ownership: only revoke a node this user's own Headscale namespace actually owns —
      // listUserDevices() is already scoped to req.user.id, so a foreign nodeId simply won't
      // appear in it (the same 404-not-403 pattern used for clusters/deployments).
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
