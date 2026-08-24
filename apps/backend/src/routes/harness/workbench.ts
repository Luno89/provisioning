import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { isWorkspaceLanguage } from '../../lib/workspace-spec.js';
import { taskFiles } from '../../lib/experiment-authoring.js';
import type { WorkbenchService } from '../../services/WorkbenchService.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * A live sandbox for writing a verify command against, before an experiment runs one.
 *
 * Extracted from index.ts, where `/api/harness/*` was 34 routes on one `app` object.
 */
export interface workbenchRouterDeps {
  db: Database;
  workbenchService: WorkbenchService;
}

export function workbenchRouter(deps: workbenchRouterDeps): Router {
  const { db, workbenchService } = deps;
  const router = Router();

  /** ── WORKBENCH — a live sandbox for writing a verify command against ── */

  router.post('/open', async (req, res) => {
    try {
      const { language, seed } = req.body ?? {};
      res.json(await workbenchService.open(userOf(req).id, {
        ...(isWorkspaceLanguage(language) ? { language } : {}),
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
      // A dead session is the common case — the idle reaper took it — and is worth saying plainly
      // so the client can reopen rather than showing a failure that looks like the command's.
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
