import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { WORKSPACE_IMAGES, DEFAULT_WORKSPACE_CPU, DEFAULT_WORKSPACE_MEMORY } from '../lib/workspace-spec.js';
import { LEAF_TOOLS } from '../lib/leaf-tools.js';
import { SANDBOX_TOOLS, MAX_AGENT_STEPS } from '../lib/sandbox-tools.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { preferUsable } from '../lib/mcp-registry.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import type { Database } from '../lib/db-interface.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PersonaOptionsRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function personaOptionsRouter(deps: PersonaOptionsRouterDeps): Router {
  const { db, modelIdsFor } = deps;
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
    res.json({
      mcpServers,
      languages: Object.entries(WORKSPACE_IMAGES).map(([id, spec]) => ({
        id,
        image: spec.image,
        summary: spec.summary,
        available: spec.available,
        absent: spec.absent,
      })),
      tools: (await db.getTools())
        .map((t) => ({ name: t.name, description: t.description }))
        .filter((t, i, all) => t.name && all.findIndex((x) => x.name === t.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name)),
      defaults: { cpu: DEFAULT_WORKSPACE_CPU, memory: DEFAULT_WORKSPACE_MEMORY, maxSteps: MAX_AGENT_STEPS },
    });
  });
  return router;
}
