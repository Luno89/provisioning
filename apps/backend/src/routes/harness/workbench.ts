import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { imageForLanguage, isWorkspaceLanguage } from '../../lib/workspace-image-catalogue.js';
import { WorkspaceImageService } from '../../services/WorkspaceImageService.js';
import { taskFiles } from '../../lib/experiment-authoring.js';
import type { WorkbenchService } from '../../services/WorkbenchService.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface workbenchRouterDeps {
  db: Database;
  workbenchService: WorkbenchService;
}

export function workbenchRouter(deps: workbenchRouterDeps): Router {
  const { db, workbenchService } = deps;
  const router = Router();

  router.post('/open', async (req, res) => {
    try {
      const { language, seed } = req.body ?? {};
      const images = await new WorkspaceImageService(db).list(userOf(req).id);
      res.json(await workbenchService.open(userOf(req).id, {
        ...(isWorkspaceLanguage(images, language) ? { language } : {}),
        image: imageForLanguage(images, language),
        ...(Array.isArray(seed) ? { seed: taskFiles(seed) } : {}),
      }));
    } catch (err: any) {
      res.status(503).json({ error: `Could not open a sandbox: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  });

  router.post('/exec', async (req, res) => {
    const { sessionId, command } = req.body ?? {};
    if (!String(command ?? '').trim()) return res.status(400).json({ error: 'No command.' });
    try {
      res.json(await workbenchService.exec(userOf(req).id, String(sessionId), String(command)));
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.post('/reset', async (req, res) => {
    const { sessionId, seed } = req.body ?? {};
    try {
      await workbenchService.reset(
        userOf(req).id,
        String(sessionId),
        Array.isArray(seed) ? taskFiles(seed) : undefined,
      );
      res.json({ reset: true });
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.delete('/:sessionId', async (req, res) => {
    await workbenchService.close(userOf(req).id, req.params.sessionId).catch(() => undefined);
    res.json({ closed: true });
  });

  return router;
}
