import { Router, type Request } from 'express';
import { asyncRoute, at } from '../../platform/index.js';
import type { ToolCallParsers } from '../services/ToolCallParsers.js';

export interface ToolCallParsersRouterDeps {
  parsers: Pick<ToolCallParsers, 'list' | 'pick'>;
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

export function toolCallParsersRouter(deps: ToolCallParsersRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req, res) => {
    res.json((await deps.parsers.list()).map(({ parser, label }) => ({ parser, label })));
  }));

  router.post('/pick', asyncRoute(async (req, res) => {
    const model = at(req.body, 'model');
    const token = at(req.body, 'hfToken');
    if (typeof model !== 'string' || !model.trim()) return res.status(400).json({ error: 'model must be the model\'s name on Hugging Face' });
    if (token !== undefined && typeof token !== 'string') return res.status(400).json({ error: 'hfToken must be text' });
    res.json(await deps.parsers.pick(model.trim(), { ownerId: userOf(req).id, token }));
  }));

  return router;
}
