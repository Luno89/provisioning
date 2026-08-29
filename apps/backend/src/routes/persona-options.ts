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

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * What a persona can be configured WITH: the toolchain images, the tool names, the MCP servers
 * this user actually has running.
 *
 * Served rather than duplicated in the UI, for the same reason the tree-type catalogue is — two
 * lists to keep in step is the failure this codebase already had with leaf columns and with
 * cluster providers.
 */
export interface PersonaOptionsRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function personaOptionsRouter(deps: PersonaOptionsRouterDeps): Router {
  const { db, modelIdsFor } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    /**
     * The MCP servers this user actually has running.
     *
     * `scope.mcp` was a free-text comma list, so granting a persona a service meant typing its name
     * from memory and matching it exactly. A typo did not fail loudly — validation only checks the
     * SHAPE — it produced a persona granted a server that does not exist, which reads at run time
     * as "the tool never appeared" three layers from the cause.
     *
     * Best-effort: the editor must open when the cluster is unreachable, just without the picker.
     */
    let mcpServers: { name: string; tools: number; unreachable?: string }[] = [];
    try {
      const reg = new McpRegistryService(db, userOf(req).id, (n: string) => resolveMcpProbeUrl(n));
      // Collapsed by name, healthiest copy first: two deployments can answer to one service.
      mcpServers = preferUsable(await reg.listWithTools()).map((s) => ({
        name: s.name,
        tools: s.tools.length,
        // Offered anyway, labelled: a server that is down is still the one you meant to name, and
        // hiding it would have the user retype a name that is already right.
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
      /**
       * Every tool a persona or pack could be allowed, FROM THE REGISTRY.
       *
       * It used to be `SANDBOX_TOOLS` + `LEAF_TOOLS`, which is a third list beside the registry and
       * the chat schemas — and it disagreed with both. Twenty-six registry tools could not be
       * granted through this editor at all (`get_logs`, `deploy_project`, every project and secret
       * tool), while eight it did offer had no registry row and so reached a model undescribed.
       *
       * Serving the registry means the things you can grant and the things that exist are one list.
       * The intersection with what an environment actually offers still happens at run time —
       * naming a tool here does not conjure it.
       */
      tools: (await db.getTools())
        .map((t) => ({ name: t.name, description: t.description }))
        .filter((t, i, all) => t.name && all.findIndex((x) => x.name === t.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name)),
      defaults: { cpu: DEFAULT_WORKSPACE_CPU, memory: DEFAULT_WORKSPACE_MEMORY, maxSteps: MAX_AGENT_STEPS },
    });
  });
  return router;
}
