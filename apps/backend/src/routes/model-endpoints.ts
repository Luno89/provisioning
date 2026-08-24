import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { isMeshAddress } from '../lib/endpoint-url-safety.js';
import { v4 as uuidv4 } from 'uuid';
import { checkEndpointUrl } from '../lib/endpoint-url-safety.js';
import { encryptValue } from '../lib/crypto.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Registered inference endpoints, and what each one is serving.
 */
export function modelEndpointsRouter(deps: Record<string, any>): Router {
  const { modelService, db, headscaleService, jwtSecret } = deps;
  const router = Router();

  /**
   * Register any OpenAI-compatible API — Ollama on a laptop, llama.cpp, LM Studio, a hosted
   * provider. The URL is checked against endpoint-url-safety.ts BEFORE it is stored, because this
   * backend will later fetch it: without that, a registered endpoint is a server-side request
   * forgery primitive aimed at the root node, which runs Headscale, Mongo and Temporal on
   * loopback. Mesh addresses additionally have to be proven to belong to the caller's own machines.
   */
  router.post('/', async (req, res) => {
    try {
      const user = userOf(req);
      const { name, baseUrl, model, apiKey } = req.body ?? {};
      if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' });

      const check = checkEndpointUrl(String(baseUrl));
      if (!check.ok) return res.status(400).json({ error: check.reason });

      const isMesh = !!(check.literalIp && isMeshAddress(check.literalIp));
      if (isMesh) {
        // Fails closed — assertOwnsMeshAddress throws if Headscale is unreachable.
        const devices = await headscaleService.listUserDevices(user.id).catch((e: any) => {
          throw new Error(`Cannot verify ownership of ${check.literalIp} — the mesh is unreachable (${e.message})`);
        });
        if (!devices.some((d: any) => d.ipAddresses.includes(check.literalIp!))) {
          return res.status(403).json({ error: `${check.literalIp} is not one of your machines. Join it under My Machines first.` });
        }
      }

      const endpoint = {
        id: uuidv4(),
        ownerId: user.id,
        name: String(name),
        baseUrl: String(baseUrl).replace(/\/$/, ''),
        ...(model ? { model: String(model) } : {}),
        ...(apiKey ? { apiKeyEnc: encryptValue(String(apiKey), jwtSecret) } : {}),
        ...(isMesh ? { isMesh: true } : {}),
        createdAt: new Date().toISOString(),
      };
      await db.saveModelEndpoint(endpoint);
      // apiKeyEnc deliberately not echoed back.
      const { apiKeyEnc: _omit, ...safe } = endpoint as any;
      res.status(201).json({ ...safe, hasApiKey: !!apiKey });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const user = userOf(req);
    const endpoints = await db.getModelEndpoints();
    const owned = endpoints.find((e: any) => e.id === req.params.id && e.ownerId === user.id);
    // 404 for both "no such id" and "not yours", so this can't enumerate other tenants' endpoints.
    if (!owned) return res.status(404).json({ error: 'Endpoint not found' });
    await db.deleteModelEndpoint(req.params.id);
    res.json({ success: true });
  });

  return router;
}
