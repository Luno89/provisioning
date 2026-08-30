import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { ToolService } from '../services/ToolService.js';
import { DEFAULT_WORKSPACE_CPU, DEFAULT_WORKSPACE_MEMORY } from '../lib/workspace-spec.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { MAX_AGENT_STEPS } from '../lib/sandbox-tools.js';
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
      languages: (await new WorkspaceImageService(db).list(userOf(req).id)).map((i) => ({
        id: i.id,
        image: i.image,
        summary: i.summary,
        available: i.available,
        absent: i.absent,
      })),
      tools: (await new ToolService(db).list(userOf(req).id))
        .map((t) => ({ name: t.name, description: t.description }))
        .filter((t, i, all) => t.name && all.findIndex((x) => x.name === t.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name)),
      defaults: { cpu: DEFAULT_WORKSPACE_CPU, memory: DEFAULT_WORKSPACE_MEMORY, maxSteps: MAX_AGENT_STEPS },
    });
  });
  return router;
}
