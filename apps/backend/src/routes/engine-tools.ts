import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { EngineToolService } from '../services/EngineToolService.js';

export interface EngineToolsRouterDeps {
  tools: EngineToolService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function engineToolsRouter(deps: EngineToolsRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json({ tools: await deps.tools.list(userOf(req).id) });
  }));

  router.get('/:name', asyncRoute(async (req: Request, res: Response) => {
    const tool = await deps.tools.get(userOf(req).id, String(req.params.name));
    if (!tool) return res.status(404).json({ error: 'There is no tool with that name' });
    return res.json({ tool });
  }));

  router.put('/:name', asyncRoute(async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (req.body?.name !== name) return res.status(400).json({ error: `the tool in the body is not called "${name}"` });

    const outcome = await deps.tools.save(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ error: 'The tool does not hold together', problems: outcome.problems });
    return res.json({ tool: outcome.tool, rebuilding: outcome.rebuilding });
  }));

  router.delete('/:name', asyncRoute(async (req: Request, res: Response) => {
    const removed = await deps.tools.remove(userOf(req).id, String(req.params.name));
    if (!removed) return res.status(404).json({ error: 'You have no copy of that tool to delete' });
    return res.json({ ok: true });
  }));

  return router;
}
