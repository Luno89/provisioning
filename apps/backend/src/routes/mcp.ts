import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { McpDecision, McpService } from '../services/McpService.js';
import type { McpServerOutcome, McpServerService } from '../services/McpServerService.js';

export interface McpRouterDeps {
  mcp: McpService;
  catalogue?: McpServerService | undefined;
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

  const catalogueOf = (res: Response): McpServerService | undefined => {
    if (!deps.catalogue) res.status(503).json({ error: 'This server keeps no catalogue of MCP servers' });
    return deps.catalogue;
  };
  const saved = (res: Response, outcome: McpServerOutcome) => (outcome.ok ? res.json(outcome.server) : res.status(outcome.status).json({ error: outcome.error }));

  router.get('/catalogue', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (catalogue) res.json(await catalogue.catalogue(userOf(req).id));
  }));

  router.get('/catalogue/:id', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (!catalogue) return;
    const server = await catalogue.get(userOf(req).id, String(req.params.id ?? ''));
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json(server);
  }));

  router.post('/catalogue', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (catalogue) saved(res.status(201), await catalogue.add(userOf(req).id, req.body ?? {}));
  }));

  router.put('/catalogue/:id', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (catalogue) saved(res, await catalogue.save(userOf(req).id, String(req.params.id ?? ''), req.body ?? {}));
  }));

  router.post('/catalogue/:id/capture', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (catalogue) saved(res, await catalogue.recapture(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.delete('/catalogue/:id', asyncRoute(async (req, res) => {
    const catalogue = catalogueOf(res);
    if (!catalogue) return;
    const removed = await catalogue.remove(userOf(req).id, String(req.params.id ?? ''));
    if (!removed.ok) return res.status(removed.status).json({ error: removed.error });
    res.json({ removed: true });
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
