import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { McpDecision, McpService } from '../services/McpService.js';

export interface McpRouterDeps {
  mcp: McpService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const answer = (res: Response, decided: McpDecision) => {
  if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
  return res.json({ ...(decided.request ? { request: decided.request } : {}), ...(decided.conversation ? { conversation: decided.conversation } : {}) });
};

export function mcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  router.get('/servers', asyncRoute(async (req, res) => {
    res.json(await deps.mcp.servers(userOf(req).id));
  }));

  router.put('/servers/:server/tools/:tool/hint', asyncRoute(async (req, res) => {
    const decided = await deps.mcp.setToolHint(userOf(req).id, String(req.params.server ?? ''), String(req.params.tool ?? ''), req.body?.choice);
    if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
    res.json(await deps.mcp.servers(userOf(req).id));
  }));

  router.get('/requests', asyncRoute(async (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
    res.json(await deps.mcp.requests(userOf(req).id, conversationId));
  }));

  router.post('/requests/:id/enable', asyncRoute(async (req, res) => {
    answer(res, await deps.mcp.enable(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.post('/requests/:id/dismiss', asyncRoute(async (req, res) => {
    answer(res, await deps.mcp.dismiss(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.put('/conversations/:id/servers', asyncRoute(async (req, res) => {
    answer(res, await deps.mcp.setConversationServers(userOf(req).id, String(req.params.id ?? ''), req.body?.servers));
  }));

  return router;
}
