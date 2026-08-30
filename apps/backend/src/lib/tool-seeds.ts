import type { ToolEffect } from './action-gate.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { SANDBOX_TOOLS } from './sandbox-tools.js';
import { KOALA_TOOLS } from './koala-tools.js';

export type ToolSurface = 'assistant' | 'planning' | 'sandbox';

export interface ToolRepositoryItem {
  id: string;
  name: string;
  ownerId?: string;
  effect?: ToolEffect;
  /**
   * Which runtimes offer this tool. Reproduces what KOALA_TOOLS / LEAF_TOOLS / SANDBOX_TOOLS were:
   * a grouping the code relied on, and one `category` cannot express because a tool can be on two
   * surfaces at once — `list_mcp_servers` is offered to a chat and to a planner.
   */
  surfaces?: ToolSurface[];
  category: 'sandbox' | 'planning' | 'database' | 'git' | 'http' | 'linter' | 'assistant' | 'web' | 'custom';
  description: string;
  usageGuidance?: string;
  compactGuidance?: string;
  requiresBinaries: string[];
  parameters?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  scriptCommand?: string;
  isBuiltIn?: boolean;
}

export const TOOL_SEEDS: ToolRepositoryItem[] = [
  {
    id: 'tool_propose_tree',
    name: 'propose_tree',
    effect: 'propose',
    category: 'assistant',
    description: 'Propose a NEW project to build in the Grove.',
    usageGuidance: 'Use this ONLY when creating a brand-new project from scratch. NEVER call this to fix, configure, or redeploy an existing project.',
    compactGuidance: 'Propose brand new project only; never use for existing project fixes.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_list_trees',
    name: 'list_trees',
    effect: 'read',
    category: 'assistant',
    description: 'List existing projects and trees in your workspace with their IDs, names, goals, and status.',
    usageGuidance: 'Call this to discover what projects already exist before creating anything new, or when answering questions about current project status.',
    compactGuidance: 'List existing projects and workspaces.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_pipeline',
    name: 'get_project_pipeline',
    effect: 'read',
    category: 'assistant',
    description: 'Check the CI/CD pipeline runs, latest commit SHA, built container image tag, and build status for an existing project.',
    usageGuidance: 'Call this to check if a project\'s code has been built by Kaniko, verify image tags, or inspect build failures before deploying.',
    compactGuidance: 'Inspect CI/CD build runs and image tag.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_env',
    name: 'get_project_env',
    effect: 'read',
    category: 'assistant',
    description: 'View the currently configured runtime environment variables (deployEnv) for an existing project.',
    usageGuidance: 'Inspect current environment variables and service bindings configured on a project before deploying or when troubleshooting credentials.',
    compactGuidance: 'View project runtime env variables.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_set_project_env',
    name: 'set_project_env',
    effect: 'write',
    category: 'assistant',
    description: 'Set or update runtime environment variables (e.g. GITEA_URL, GITEA_TOKEN, API keys) on an existing project.',
    usageGuidance: 'Call this to supply needed credentials or URLs before calling deploy_project. Format variables as KEY=VALUE lines or key-value object.',
    compactGuidance: 'Configure runtime env variables on project.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_deploy_project',
    name: 'deploy_project',
    effect: 'write',
    category: 'assistant',
    description: 'Promote and deploy an existing project\'s built container image into Kubernetes.',
    usageGuidance: 'Use this to deploy or redeploy a project after code builds or environment variables are updated. Do NOT use propose_tree to redeploy.',
    compactGuidance: 'Promote and deploy project container image.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_url',
    name: 'get_project_url',
    effect: 'read',
    category: 'assistant',
    description: 'Get the live reachable URL, listening port, cluster namespace, and health status for a deployed service.',
    usageGuidance: 'Call this to find the live endpoint and port for a deployed application.',
    compactGuidance: 'Get live URL and health of deployed project.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_get_logs',
    name: 'get_logs',
    effect: 'read',
    category: 'assistant',
    description: 'Retrieve recent container output from a deployment to see why it failed or crashed.',
    usageGuidance: 'ALWAYS check container logs before diagnosing why a pod or service is in CrashLoopBackOff. Do not guess root causes from app names.',
    compactGuidance: 'Retrieve container stdout/stderr logs.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_get_events',
    name: 'get_events',
    effect: 'read',
    category: 'assistant',
    description: 'Recent Kubernetes events for a deployment (image pull failures, unschedulable pods, volume mount errors).',
    usageGuidance: 'Call this when get_logs is empty or when pods fail to start or schedule.',
    compactGuidance: 'Inspect k8s pod/deployment events.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_inspect_resources',
    name: 'inspect_resources',
    effect: 'read',
    category: 'assistant',
    description: 'Read the live state of Kubernetes objects (pods, deployments, services, pvc, nodes). Read-only.',
    usageGuidance: 'Use verb "get" or "describe" to inspect status, pending reasons, or PVC bindings.',
    compactGuidance: 'Read-only k8s resource inspector.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_cluster_capacity',
    name: 'cluster_capacity',
    effect: 'read',
    category: 'assistant',
    description: 'What the cluster has left: node CPU/memory usage and pressure conditions.',
    usageGuidance: 'Call when wondering why pods cannot schedule or why things run slowly.',
    compactGuidance: 'Check node CPU, memory, and pressure.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_list_infrastructure',
    name: 'list_infrastructure',
    effect: 'read',
    category: 'assistant',
    description: 'What is running in the cluster (databases, storage, platform services) and what can be deployed.',
    usageGuidance: 'Call before proposing backing services or when checking if a database or platform service is running.',
    compactGuidance: 'List running backing services and deployable specs.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_add_project_dependency',
    name: 'add_project_dependency',
    effect: 'write',
    category: 'assistant',
    description: 'Declare that an existing project depends on a running backing service.',
    usageGuidance: 'Binds a project to a running database or cache reported by list_infrastructure.',
    compactGuidance: 'Bind project to running backing service.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_propose_spec',
    name: 'propose_spec',
    effect: 'propose',
    category: 'assistant',
    description: 'Propose a new deployable backing service specification (database, cache, queue).',
    usageGuidance: 'Use when the user needs an infrastructure type not in list_infrastructure.',
    compactGuidance: 'Propose new backing service app spec.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_request_escalated_privileges',
    name: 'request_escalated_privileges',
    effect: 'propose',
    category: 'assistant',
    description: 'Request elevated access to cluster-wide system namespaces (monitoring, gitea, kube-system) or administrator privileges.',
    usageGuidance: 'Call this when you need to inspect cluster system services (Prometheus, Grafana, Loki, Gitea) or diagnose nodes outside user tenancy. State a clear, honest reason.',
    compactGuidance: 'Request elevated cluster privileges.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_list_mcp_servers',
    name: 'list_mcp_servers',
    effect: 'read',
    category: 'assistant',
    description: 'Detail on the MCP services deployed under your account — tools exposed and readiness.',
    usageGuidance: 'Call when you need to know what tools an MCP service offers before deciding whether to enable it.',
    compactGuidance: 'List deployed MCP services and exposed tools.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_enable_mcp_server',
    name: 'enable_mcp_server',
    effect: 'write',
    category: 'assistant',
    description: 'Hook up a deployed MCP service, loading its tools immediately into this conversation.',
    usageGuidance: 'Enable a service when you need its tools. Its tools become available immediately in this same reply.',
    compactGuidance: 'Attach MCP service and load its tools.',
    requiresBinaries: [],
    isBuiltIn: true,
  },

  {
    id: 'tool_web_search',
    name: 'web_search',
    effect: 'read',
    category: 'web',
    description: 'Search the open web using SearXNG. Returns titles, URLs, and text snippets.',
    usageGuidance: 'Use when looking up library documentation, API contracts, or current error messages.',
    compactGuidance: 'Search web for docs/APIs.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'tool_fetch_web_page',
    name: 'fetch_web_page',
    effect: 'read',
    category: 'web',
    description: 'Fetch the markdown text content of a web page by URL.',
    usageGuidance: 'Use after web_search to read full documentation pages or specifications.',
    compactGuidance: 'Fetch markdown of web URL.',
    requiresBinaries: [],
    isBuiltIn: true,
  },

  {
    id: 'read_file_tool',
    name: 'read_file',
    category: 'sandbox',
    description: 'Read the text content of a file from the sandbox filesystem (/work).',
    usageGuidance: 'Inspect existing code or configuration before modifying it.',
    compactGuidance: 'Read file from /work sandbox.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'write_file_tool',
    name: 'write_file',
    category: 'sandbox',
    description: 'Create or overwrite a file in the sandbox filesystem with text content.',
    usageGuidance: 'Write complete, fully-implemented code. Never write placeholders or TODOs.',
    compactGuidance: 'Create/overwrite file in /work sandbox.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'run_command_tool',
    name: 'run_command',
    category: 'sandbox',
    description: 'Execute a bash shell command inside the sandbox container.',
    usageGuidance: 'Run builds, tests, or scripts inside the isolated sandbox.',
    compactGuidance: 'Execute bash command in sandbox.',
    requiresBinaries: ['bash'],
    isBuiltIn: true,
  },
  {
    id: 'finish_tool',
    name: 'finish',
    category: 'sandbox',
    description: 'Signal that the task is complete and end the agent execution turn.',
    usageGuidance: 'Call when all work is done and tests have verified success.',
    compactGuidance: 'Signal task completion.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'test_runner_tool',
    name: 'run_tests',
    surfaces: ['sandbox'],
    category: 'sandbox',
    description: 'Execute unit tests (Vitest/Jest/Pytest/Go test) in the sandbox and return failing assertions.',
    usageGuidance: 'Run tests to verify code changes before finishing.',
    compactGuidance: 'Run unit test suite in sandbox.',
    requiresBinaries: ['node', 'npm'],
    isBuiltIn: true,
  },
  {
    id: 'git_diff_inspector',
    name: 'inspect_git_diff',
    surfaces: ['sandbox'],
    category: 'git',
    description: 'Inspect current uncommitted diffs and staged changes against the base branch in the sandbox.',
    usageGuidance: 'Check your modifications before concluding work.',
    compactGuidance: 'Inspect uncommitted git diffs in sandbox.',
    requiresBinaries: ['git'],
    isBuiltIn: true,
  },
  {
    id: 'http_request_tester',
    name: 'test_http_endpoint',
    surfaces: ['sandbox'],
    category: 'http',
    description: 'Execute an HTTP request against a local running service port inside the sandbox.',
    usageGuidance: 'Verify that an HTTP server responds correctly to requests.',
    compactGuidance: 'Execute local HTTP request in sandbox.',
    requiresBinaries: ['curl'],
    isBuiltIn: true,
  },
  {
    id: 'linter_audit_tool',
    name: 'run_linter_audit',
    surfaces: ['sandbox'],
    category: 'linter',
    description: 'Run static code analysis or linter check on sandbox files and return structured warnings.',
    usageGuidance: 'Check code quality and type compliance.',
    compactGuidance: 'Run static linter analysis.',
    requiresBinaries: ['node', 'npm'],
    isBuiltIn: true,
  },
  {
    id: 'db_query_tool',
    name: 'query_in_memory_db',
    surfaces: ['sandbox'],
    category: 'database',
    description: 'Execute a read/write query against an in-memory test database instance in the sandbox.',
    usageGuidance: 'Verify test database state in sandbox runs.',
    compactGuidance: 'Query in-memory test database.',
    requiresBinaries: ['node'],
    isBuiltIn: true,
  },
  {
    id: 'save_harness_memory_tool',
    name: 'save_harness_memory',
    surfaces: ['sandbox'],
    category: 'sandbox',
    description: 'Record a persistent lesson learned, environment fact, or prompt guidance rule into the Memory Bank.',
    usageGuidance: 'Preserve key findings or patterns learned during execution.',
    compactGuidance: 'Record lesson/fact into Memory Bank.',
    requiresBinaries: [],
    isBuiltIn: true,
  },

  {
    id: 'list_leaves_tool',
    name: 'list_leaves',
    effect: 'read',
    category: 'planning',
    description: 'List work items (leaves) already tracked on this branch to avoid duplicating work.',
    usageGuidance: 'Check existing leaves before proposing new tasks.',
    compactGuidance: 'List tracked work leaves on branch.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'get_leaf_tool',
    name: 'get_leaf',
    effect: 'read',
    category: 'planning',
    description: 'Fetch full detail of a leaf: description, sub-items, and failed attempt error logs.',
    usageGuidance: 'Read full leaf specifications and test output.',
    compactGuidance: 'Fetch detailed leaf specification and logs.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'propose_leaf_tool',
    name: 'propose_leaf',
    effect: 'write',
    category: 'planning',
    description: 'Propose a new piece of work as a PROPOSAL on this branch.',
    usageGuidance: 'Propose an atomic, concrete unit of engineering work on the current branch.',
    compactGuidance: 'Propose new leaf on current branch.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'revise_leaf_tool',
    name: 'revise_leaf',
    effect: 'write',
    category: 'planning',
    description: 'Change the title or description of a proposed leaf.',
    usageGuidance: 'Refine or clarify a proposed task.',
    compactGuidance: 'Update proposed leaf title/body.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'withdraw_leaf_tool',
    name: 'withdraw_leaf',
    effect: 'write',
    category: 'planning',
    description: 'Withdraw a leaf proposal that is no longer needed.',
    usageGuidance: 'Remove duplicate or obsolete proposals.',
    compactGuidance: 'Withdraw unneeded leaf proposal.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'list_projects_tool',
    name: 'list_projects',
    effect: 'read',
    category: 'planning',
    description: 'List registered git repositories for the current user.',
    usageGuidance: 'Find existing git repos to attach leaves to.',
    compactGuidance: 'List registered user git repositories.',
    requiresBinaries: ['git'],
    isBuiltIn: true,
  },
  {
    id: 'create_project_tool',
    name: 'create_project',
    effect: 'write',
    category: 'planning',
    description: 'Create a new private git repository for the user.',
    usageGuidance: 'Create a git repository in Gitea for project code.',
    compactGuidance: 'Create private git repository.',
    requiresBinaries: ['git'],
    isBuiltIn: true,
  },
  {
    id: 'set_leaf_project_tool',
    name: 'set_leaf_project',
    effect: 'write',
    category: 'planning',
    description: 'Attach a leaf to a git repository project.',
    usageGuidance: 'Bind a leaf to a specific git repository for code commits.',
    compactGuidance: 'Attach leaf to git repository project.',
    requiresBinaries: ['git'],
    isBuiltIn: true,
  },
  {
    id: 'request_secret_tool',
    name: 'request_secret',
    effect: 'propose',
    category: 'assistant',
    description: 'Request a sensitive credential, token, or API key from the user via a secure interactive UI card. The secret is encrypted and vaulted directly in Infisical without appearing in chat logs.',
    usageGuidance: 'Call this tool whenever an application requires a sensitive token, API key, or password. NEVER ask the user to type sensitive credentials into chat text. Once the user submits the secret, write the application code to read it via standard environment variables (process.env.<KEY>), and inject it into the pod with inject_secret_to_pod.',
    compactGuidance: 'Prompt user with secure modal to vault a token or API key directly into Infisical.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'inject_secret_to_pod_tool',
    name: 'inject_secret_to_pod',
    effect: 'write',
    category: 'assistant',
    description: 'Inject a vaulted secret into a deployed project pod via Kubernetes Secret (<app>-secrets) as an environment variable or file, and trigger a rolling restart.',
    usageGuidance: 'Mounts a vaulted Infisical secret reference into the target pod\'s Kubernetes Secret as a standard environment variable accessible to the application runtime, and restarts the pod.',
    compactGuidance: 'Inject vaulted secret into pod as env var and trigger rolling restart.',
    requiresBinaries: ['kubectl'],
    isBuiltIn: true,
  },
  {
    id: 'get_project_secret_tool',
    name: 'get_project_secret',
    effect: 'read',
    category: 'assistant',
    description: 'Retrieve metadata and vault reference for a project secret in Infisical.',
    usageGuidance: 'Check whether a secret key is already vaulted for a project.',
    compactGuidance: 'Retrieve secret metadata from Infisical vault.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'set_project_secret_tool',
    name: 'set_project_secret',
    effect: 'write',
    category: 'assistant',
    description: 'Set or update a secret in a project\'s Infisical vault.',
    usageGuidance: 'Store or update an encrypted secret in Infisical. Returns a vault reference URI.',
    compactGuidance: 'Save encrypted secret in Infisical vault.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
  {
    id: 'list_project_secrets_tool',
    name: 'list_project_secrets',
    effect: 'read',
    category: 'assistant',
    description: 'List configured secret keys in Infisical for a project with masked previews (never raw plaintext).',
    usageGuidance: 'List all vaulted secrets for a project. Values are masked for security.',
    compactGuidance: 'List project secrets with masked values.',
    requiresBinaries: [],
    isBuiltIn: true,
  },
];

const DERIVED_EFFECT: Record<string, ToolEffect | undefined> = {
  ingest_status: 'read',
  list_personas: 'read',
  replace_leaf: 'write',
  search_corpus: 'read',
  set_acceptance: 'write',
  start_ingest: 'write',
  update_leaf_memory: 'write',
};

const DERIVED_CATEGORY: Record<string, ToolRepositoryItem['category']> = {
  start_ingest: 'web', ingest_status: 'web', search_corpus: 'web',
  set_acceptance: 'planning', validate_progress: 'planning', replace_leaf: 'planning',
  list_personas: 'planning', update_leaf_memory: 'planning',
};

function derivedSeeds(declared: readonly { function: { name: string; description?: string; parameters?: unknown } }[]): ToolRepositoryItem[] {
  const already = new Set(TOOL_SEEDS.map((t) => t.name));
  return declared
    .filter((t) => !already.has(t.function.name) && DERIVED_CATEGORY[t.function.name])
    .map((t) => ({
      id: `tool_${t.function.name}`,
      name: t.function.name,
      category: DERIVED_CATEGORY[t.function.name]!,
      description: t.function.description ?? t.function.name,
      requiresBinaries: [],
      ...(DERIVED_EFFECT[t.function.name] ? { effect: DERIVED_EFFECT[t.function.name]! } : {}),
      isBuiltIn: true,
    }));
}

const SURFACE_ARRAYS: [ToolSurface, readonly { function: { name: string; parameters?: unknown } }[]][] = [
  ['assistant', KOALA_TOOLS as never],
  ['planning', LEAF_TOOLS as never],
  ['sandbox', SANDBOX_TOOLS as never],
];

/**
 * The surfaces and parameter schema each tool has, taken from the live declarations.
 *
 * Derived rather than restated while the arrays still exist: a hand-copied schema would be a second
 * copy of a contract the dispatcher owns, and the last time this catalogue kept its own copy the
 * two had drifted on 26 of 49 tools. The arrays are deleted once every reader takes rows, and the
 * values are written out here at that point under a test that they match.
 */
function declaredFor(name: string): { surfaces: ToolSurface[]; parameters?: ToolRepositoryItem['parameters'] } {
  const surfaces: ToolSurface[] = [];
  let parameters: ToolRepositoryItem['parameters'];
  for (const [surface, arr] of SURFACE_ARRAYS) {
    const found = arr.find((t) => t.function.name === name);
    if (!found) continue;
    surfaces.push(surface);
    parameters ??= found.function.parameters as ToolRepositoryItem['parameters'];
  }
  return { surfaces, ...(parameters ? { parameters } : {}) };
}

export const ALL_TOOL_SEEDS: ToolRepositoryItem[] = [
  ...TOOL_SEEDS,
  ...derivedSeeds([...LEAF_TOOLS, ...SANDBOX_TOOLS]),
].map((row): ToolRepositoryItem => {
  const { surfaces, parameters } = declaredFor(row.name);
  // A row may state a surface the arrays do not: six sandbox tools are dispatched by the agent
  // loop and were never in SANDBOX_TOOLS, so deriving from the arrays alone dropped them.
  const merged = [...new Set([...(row.surfaces ?? []), ...surfaces])];
  return {
    ...row,
    ...(merged.length ? { surfaces: merged } : {}),
    ...(parameters ? { parameters } : {}),
  };
});

export interface ToolSeedStore {
  getTools(): Promise<ToolRepositoryItem[]>;
  saveTool(tool: ToolRepositoryItem): Promise<void>;
}

export async function seedTools(store: ToolSeedStore): Promise<number> {
  const existing = await store.getTools();
  const existingMap = new Map(existing.map((t) => [t.name, t]));
  let seededCount = 0;

  for (const seed of ALL_TOOL_SEEDS) {
    const prev = existingMap.get(seed.name);
    if (prev && prev.isBuiltIn === false) continue;
    const next = { ...seed, id: prev?.id ?? seed.id };
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
    await store.saveTool(next);
    seededCount++;
  }

  return seededCount;
}
