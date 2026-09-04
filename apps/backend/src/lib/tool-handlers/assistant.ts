import { KOALA_TOOL_HANDLERS } from '../koala-tools.js';
import type { KoalaToolContext, KoalaToolHandler } from '../koala-tool-handlers.js';
import type { ToolEntry, ToolNeed, ToolRuntime } from '../tool-runtime.js';

/**
 * The assistant tools, as registry entries.
 *
 * The handlers themselves are unchanged -- `koala-tool-handlers.ts` still owns them. What changes
 * is that they are no longer reachable only from a chat: a handler needing nothing but the database
 * runs in a planning turn or a sandbox run just as well, and now does.
 */
const asRuntime = (rt: ToolRuntime): KoalaToolContext => ({
  db: rt.db,
  userId: rt.userId,
  conversationId: rt.conversationId ?? '',
  ...(rt.sessionId ? { sessionId: rt.sessionId } : {}),
  servers: rt.servers ?? [],
  webSearch: rt.webSearch!,
  fetchWebPage: rt.fetchWebPage!,
  ...(rt.kubectl ? { kubectl: rt.kubectl } : {}),
  ...(rt.temporalBridge ? { temporalBridge: rt.temporalBridge } : {}),
  ...(rt.infisicalService ? { infisicalService: rt.infisicalService } : {}),
  ...(rt.clusterService ? { clusterService: rt.clusterService } : {}),
  ...(rt.projects ? { projects: rt.projects } : {}),
  ...(rt.isAdmin !== undefined ? { isAdmin: rt.isAdmin } : {}),
  ...(rt.isEscalated !== undefined ? { isEscalated: rt.isEscalated } : {}),
  ...(rt.escalatedNamespaces ? { escalatedNamespaces: rt.escalatedNamespaces } : {}),
  ...(rt.permitted ? { permitted: rt.permitted } : {}),
});

/**
 * What each one needs, read off what its handler actually touches.
 *
 * `list_mcp_servers` is absent on purpose: the planning implementation also names the project each
 * server is built from, so that one is the single handler for the name.
 */
const OWNS: Record<string, readonly ToolNeed[]> = {
  add_project_dependency: [],
  list_infrastructure: [],
  list_trees: [],
  list_tree_types: [],
  get_project_pipeline: [],
  get_project_url: [],
  get_project_env: [],
  set_project_env: [],
  web_search: ['web'],
  fetch_web_page: ['web'],
  enable_mcp_server: ['servers', 'conversationId'],
  propose_spec: ['conversationId'],
  propose_tree: ['conversationId'],
  request_escalated_privileges: ['conversationId'],
  request_secret: ['conversationId'],
  get_logs: ['kubectl'],
  get_events: ['kubectl'],
  inspect_resources: ['kubectl'],
  cluster_capacity: ['kubectl'],
  list_clusters: ['clusterService'],
  deploy_project: ['temporalBridge'],
  deploy_app: ['temporalBridge'],
  inject_secret_to_pod: ['infisicalService'],
  get_project_secret: ['infisicalService'],
  set_project_secret: ['infisicalService'],
  list_project_secrets: ['infisicalService'],
};

const handlers = KOALA_TOOL_HANDLERS as Record<string, KoalaToolHandler>;

export const ASSISTANT_ENTRIES: Record<string, ToolEntry> = Object.fromEntries(
  Object.entries(OWNS).map(([name, needs]) => [name, {
    needs,
    run: (rt: ToolRuntime, args: Record<string, unknown>) => handlers[name]!(asRuntime(rt), args),
  } satisfies ToolEntry]),
);
