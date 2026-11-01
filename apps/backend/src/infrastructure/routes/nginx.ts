import { at } from '../../platform/index.js';
import { Router } from 'express';
import fs from 'fs/promises';

export interface NginxRouterDeps {
  nginxConfPath: string;
}

export function nginxRouter(deps: NginxRouterDeps): Router {
  const { nginxConfPath } = deps;
  const router = Router();

  router.get('/config', async (req, res) => {
    try { res.json({ content: await fs.readFile(nginxConfPath, 'utf-8') }); }
    catch (err) { res.status(500).json({ error: `Failed to read nginx config: ${(err as Error).message}` }); }
  });

  router.post('/config', async (req, res) => {
    try {
      const content = at(req.body, 'content');
      if (typeof content !== 'string') return res.status(400).json({ error: 'Config content must be a string' });
      await fs.writeFile(nginxConfPath, content);

      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      await execAsync('docker exec provisioner-nginx nginx -s reload');
      res.json({ message: 'Nginx config updated and reloaded successfully' });
    } catch (err) { res.status(500).json({ error: `Failed to update nginx config: ${(err as Error).message}` }); }
  });

  return router;
}
