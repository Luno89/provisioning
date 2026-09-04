import type { ToolEffect } from './action-gate.js';
import type { Database } from './db-interface.js';
import type { McpServer } from './mcp-registry.js';
import type { WebSearchFn } from './web-tools.js';
import type { ValidationRecipe } from './tree-types.js';
import type { SandboxDriver, SaveMemory } from './sandbox-tool-runner.js';
import type { ResearchFinding } from './research-agent.js';
import type {
  ProposedTree, ProposedSpec, ProposedEscalation, ProposedSecretRequest,
} from './conversations.js';
import type { McpRegistryService } from '../services/McpRegistryService.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { ClusterService } from '../services/ClusterService.js';

/**
 * Everything any tool can be given, in one bag.
 *
 * There used to be three of these -- `KoalaToolContext`, `LeafToolContext` and the loose argument
 * list of `runSandboxTool` -- and which one you held decided which tools you could call. That is
 * what made a pack able to GRANT `get_leaf` and the chat runtime unable to RUN it: the grant list
 * is edited against the whole catalogue, but dispatch was three maps that each knew a third of it.
 *
 * A field here is a resource, not a category. A tool declares the resources it needs in `needs`,
 * and a runtime that has them can run it, wherever that runtime happens to be.
 */
export interface ToolRuntime {
  db: Database;
  userId: string;

  /** Web access, as a pair: a run has both or neither, and `needs: ['web']` asks for it. */
  webSearch?: WebSearchFn | undefined;
  fetchWebPage?: ((url: string) => Promise<string>) | undefined;

  /** The branch a leaf write attaches to, when the caller is already working inside one. */
  branchId?: string | undefined;
  conversationId?: string | undefined;
  sessionId?: string | undefined;

  projects?: ProjectRepoService | undefined;
  sandbox?: SandboxDriver | undefined;
  servers?: readonly McpServer[] | undefined;
  mcpRegistry?: Pick<McpRegistryService, 'listWithTools'> | undefined;
  kubectl?: ((args: string[]) => Promise<string>) | undefined;
  temporalBridge?: Pick<TemporalBridge, 'promoteProjectBuild' | 'deployApp'> | undefined;
  infisicalService?: InfisicalService | undefined;
  clusterService?: Pick<ClusterService, 'getById' | 'getAll'> | undefined;

  ingest?: {
    start: (args: { ownerId: string; url: string; maxDepth?: number; maxPages?: number; domains?: string[]; keywords?: string[] }) => Promise<{ workflowId: string }>;
    status: (workflowId: string) => Promise<{ state: string; receipt?: unknown; error?: string }>;
    search: (args: { ownerId: string; query: string; ingestId?: string }) => Promise<{ hits: { url: string; snippet: string }[] }>;
  } | undefined;

  research?: ((questions: string[]) => Promise<ResearchFinding[]>) | undefined;

  /** Sandbox-run extras. Only a sandbox run has them, and only sandbox tools read them. */
  transcript?: string[] | undefined;
  saveMemory?: SaveMemory | undefined;
  validationRecipe?: ValidationRecipe | undefined;
  fetchImpl?: typeof fetch;

  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
  permitted?: readonly ToolEffect[] | undefined;
}

/** What a tool hands back. The proposal fields are the chat runtime's; everything else ignores them. */
export interface ToolOutcome {
  content: string;
  enabled?: string;
  proposed?: ProposedTree;
  proposedSpec?: ProposedSpec;
  proposedEscalation?: ProposedEscalation;
  proposedSecretRequest?: ProposedSecretRequest;
}

/** The resources a tool can ask for. Each maps to one optional field of `ToolRuntime`. */
export type ToolNeed =
  | 'web' | 'projects' | 'sandbox' | 'servers' | 'mcpRegistry' | 'kubectl'
  | 'temporalBridge' | 'infisicalService' | 'clusterService' | 'ingest' | 'research' | 'conversationId';

export interface ToolEntry {
  /** Resources without which this tool cannot run. Empty means it runs anywhere. */
  needs: readonly ToolNeed[];
  run(rt: ToolRuntime, args: Record<string, unknown>): Promise<ToolOutcome>;
}

/** What to tell a model that called a tool this run cannot serve. Names the resource, not a surface. */
export const NEED_EXPLANATION: Record<ToolNeed, string> = {
  web: 'web access',
  projects: 'a project repository service',
  sandbox: 'a sandbox to run in',
  servers: 'the list of deployed MCP servers',
  mcpRegistry: 'the MCP registry',
  kubectl: 'cluster access',
  temporalBridge: 'the workflow engine',
  infisicalService: 'the secret store',
  clusterService: 'the cluster list',
  ingest: 'the ingestion service',
  research: 'a research agent',
  conversationId: 'a conversation to attach the proposal to',
};

export const json = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value) });

/** Whether this runtime can serve a need. `web` is the one pair rather than a single field. */
export function has(rt: ToolRuntime, need: ToolNeed): boolean {
  if (need === 'web') return Boolean(rt.webSearch && rt.fetchWebPage);
  return rt[need] != null;
}
