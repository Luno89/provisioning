import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';

export interface WorkspaceDependenciesRouterDeps {
  dependencies: Pick<WorkspaceDependencyService, 'list' | 'save' | 'remove'>;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function workspaceDependenciesRouter(deps: WorkspaceDependenciesRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json({ dependencies: await deps.dependencies.list(userOf(req).id) });
  }));

  router.put('/:name', asyncRoute(async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (req.body?.name !== name) return res.status(400).json({ error: `the dependency in the body is not called "${name}"` });
    const outcome = await deps.dependencies.save(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ error: outcome.problems.join('; '), problems: outcome.problems });
    return res.json({ dependency: outcome.dependency });
  }));

  router.delete('/:name', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.dependencies.remove(userOf(req).id, String(req.params.name));
    if (!outcome.removed) return res.status(409).json({ error: outcome.why });
    return res.json({ ok: true });
  }));

  return router;
}
