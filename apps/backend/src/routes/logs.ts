import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import fs from 'fs/promises';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Provisioning and pipeline logs read off disk. The live tail is socket.io, not this.
 */
export function logsRouter(deps: Record<string, any>): Router {
  const { db, clusterService, appService } = deps;
  const router = Router();

  /** ── LOGS ── */
  router.get('/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster'
      ? await clusterService.getById(id, userOf(req).id)
      : type === 'pipeline'
      ? (await db.getPipelineRuns()).find((r: any) => r.id === id)
      : (await appService.getAll(userOf(req).id)).find((d: any) => d.id === id);
    const logPath = type === 'pipeline' ? (resource as any)?.logFile : (resource as any)?.lastLogPath;
    if (!resource || !logPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      res.json({ content });
    }
    catch {
      res.json({ content: 'Waiting for logs...' });
    }
  });

  return router;
}
