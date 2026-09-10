import { Router, type Request } from 'express';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { preferUsable } from '../lib/mcp-registry.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import type { Database } from '../lib/db-interface.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PersonaOptionsRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function personaOptionsRouter(deps: PersonaOptionsRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    let mcpServers: { name: string; tools: number; unreachable?: string }[] = [];
    try {
      const reg = new McpRegistryService(db, userOf(req).id, (n: string) => resolveMcpProbeUrl(n));
      mcpServers = preferUsable(await reg.listWithTools()).map((s) => ({
        name: s.name,
        tools: s.tools.length,
        ...(s.unreachable ? { unreachable: s.unreachable } : {}),
      }));
    } catch (err: any) {
      console.warn(`[persona-options] could not list MCP servers: ${err.message}`);
    }
    res.json({ mcpServers });
  });
  return router;
}
