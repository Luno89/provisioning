import { Router, type Request, type Response } from 'express';
import { LANGUAGE_IDS } from '@koala/agent-engine';
import { asyncRoute } from '../middleware/async-route.js';
import type { AgentService } from '../services/AgentService.js';

export interface AgentsRouterDeps {
  agents: AgentService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function agentsRouter(deps: AgentsRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json({ agents: await deps.agents.list(userOf(req).id) });
  }));

  router.get('/tools', asyncRoute(async (req: Request, res: Response) => {
    res.json({ tools: await deps.agents.grantable(userOf(req).id), languages: LANGUAGE_IDS });
  }));

  router.get('/:slug', asyncRoute(async (req: Request, res: Response) => {
    const agent = await deps.agents.get(userOf(req).id, String(req.params.slug));
    if (!agent) return res.status(404).json({ error: 'There is no agent with that slug' });
    return res.json({ agent });
  }));

  router.put('/:slug', asyncRoute(async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    if (req.body?.slug !== slug) return res.status(400).json({ error: `the agent in the body is not called "${slug}"` });

    const outcome = await deps.agents.save(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ error: 'The agent does not hold together', problems: outcome.problems });
    return res.json({ agent: outcome.agent });
  }));

  router.delete('/:slug', asyncRoute(async (req: Request, res: Response) => {
    const removed = await deps.agents.remove(userOf(req).id, String(req.params.slug));
    if (!removed) return res.status(404).json({ error: 'You have no copy of that agent to delete' });
    return res.json({ ok: true });
  }));

  return router;
}
