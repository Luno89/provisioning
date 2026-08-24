import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import fs from 'fs/promises';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The host nginx config — read, and written back after the editor saves it.
 */
export function nginxRouter(deps: Record<string, any>): Router {
  const { infraService, nginxConfPath } = deps;
  const router = Router();

  router.get('/config', async (req, res) => {
    try { res.json({ content: await fs.readFile(nginxConfPath, 'utf-8') }); }
    catch (err: any) { res.status(500).json({ error: `Failed to read nginx config: ${err.message}` }); }
  });

  router.post('/config', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Config content must be a string' });
      await fs.writeFile(nginxConfPath, content);

      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      await execAsync('docker exec provisioner-nginx nginx -s reload');
      res.json({ message: 'Nginx config updated and reloaded successfully' });
    } catch (err: any) { res.status(500).json({ error: `Failed to update nginx config: ${err.message}` }); }
  });

  return router;
}
