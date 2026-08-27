/**
 * tool-seeds.ts — Complete catalogue of built-in platform tools with schema definitions,
 * operational workflow guidance, and database seeding utilities.
 */

export interface ToolRepositoryItem {
  id: string;
  name: string;
  category: 'sandbox' | 'planning' | 'database' | 'git' | 'http' | 'linter' | 'assistant' | 'web' | 'custom';
  description: string;
  usageGuidance?: string;
  compactGuidance?: string;
  requiresBinaries: string[];
  parameters: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  scriptCommand?: string;
  isBuiltIn?: boolean;
}

export const TOOL_SEEDS: ToolRepositoryItem[] = [
  // ── ASSISTANT / OPERATOR TOOLS ──
  {
    id: 'tool_propose_tree',
    name: 'propose_tree',
    category: 'assistant',
    description: 'Propose a NEW project to build in the Grove.',
    usageGuidance: 'Use this ONLY when creating a brand-new project from scratch. NEVER call this to fix, configure, or redeploy an existing project.',
    compactGuidance: 'Propose brand new project only; never use for existing project fixes.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the project, e.g. "GitHub API MCP".' },
        type: { type: 'string', description: 'What kind of project this is. Call list_tree_types for valid ids.' },
        goal: { type: 'string', description: 'What done looks like in a sentence or two.' },
      },
      required: ['name', 'goal'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_trees',
    name: 'list_trees',
    category: 'assistant',
    description: 'List existing projects and trees in your workspace with their IDs, names, goals, and status.',
    usageGuidance: 'Call this to discover what projects already exist before creating anything new, or when answering questions about current project status.',
    compactGuidance: 'List existing projects and workspaces.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_pipeline',
    name: 'get_project_pipeline',
    category: 'assistant',
    description: 'Check the CI/CD pipeline runs, latest commit SHA, built container image tag, and build status for an existing project.',
    usageGuidance: 'Call this to check if a project\'s code has been built by Kaniko, verify image tags, or inspect build failures before deploying.',
    compactGuidance: 'Inspect CI/CD build runs and image tag.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to inspect.' },
        name: { type: 'string', description: 'Project name to inspect, if ID is not known.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_env',
    name: 'get_project_env',
    category: 'assistant',
    description: 'View the currently configured runtime environment variables (deployEnv) for an existing project.',
    usageGuidance: 'Inspect current environment variables and service bindings configured on a project before deploying or when troubleshooting credentials.',
    compactGuidance: 'View project runtime env variables.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to inspect.' },
        name: { type: 'string', description: 'Project name to inspect, if ID is not known.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_set_project_env',
    name: 'set_project_env',
    category: 'assistant',
    description: 'Set or update runtime environment variables (e.g. GITEA_URL, GITEA_TOKEN, API keys) on an existing project.',
    usageGuidance: 'Call this to supply needed credentials or URLs before calling deploy_project. Format variables as KEY=VALUE lines or key-value object.',
    compactGuidance: 'Configure runtime env variables on project.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to configure.' },
        name: { type: 'string', description: 'Project name to configure, if ID is not known.' },
        env: {
          type: 'object',
          description: 'Key-value mapping of environment variables to set or merge (e.g. {"GITEA_URL": "http://...", "GITEA_TOKEN": "..."}).',
        },
      },
      required: ['env'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_deploy_project',
    name: 'deploy_project',
    category: 'assistant',
    description: 'Promote and deploy an existing project\'s built container image into Kubernetes.',
    usageGuidance: 'Use this to deploy or redeploy a project after code builds or environment variables are updated. Do NOT use propose_tree to redeploy.',
    compactGuidance: 'Promote and deploy project container image.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to deploy.' },
        name: { type: 'string', description: 'Project name to deploy, if ID is not known.' },
        runId: { type: 'string', description: 'Specific pipeline run ID to promote, if not latest.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_url',
    name: 'get_project_url',
    category: 'assistant',
    description: 'Get the live reachable URL, listening port, cluster namespace, and health status for a deployed service.',
    usageGuidance: 'Call this to find the live endpoint and port for a deployed application.',
    compactGuidance: 'Get live URL and health of deployed project.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID.' },
        name: { type: 'string', description: 'Project name.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_logs',
    name: 'get_logs',
    category: 'assistant',
    description: 'Retrieve recent container output from a deployment to see why it failed or crashed.',
    usageGuidance: 'ALWAYS check container logs before diagnosing why a pod or service is in CrashLoopBackOff. Do not guess root causes from app names.',
    compactGuidance: 'Retrieve container stdout/stderr logs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        deployment: { type: 'string', description: 'The deployment name, as reported by list_infrastructure.' },
        namespace: { type: 'string', description: 'Optional namespace (e.g. "monitoring", "gitea").' },
      },
      required: ['deployment'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_events',
    name: 'get_events',
    category: 'assistant',
    description: 'Recent Kubernetes events for a deployment (image pull failures, unschedulable pods, volume mount errors).',
    usageGuidance: 'Call this when get_logs is empty or when pods fail to start or schedule.',
    compactGuidance: 'Inspect k8s pod/deployment events.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        deployment: { type: 'string', description: 'The deployment name, as reported by list_infrastructure.' },
        namespace: { type: 'string', description: 'Optional namespace.' },
      },
      required: ['deployment'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_inspect_resources',
    name: 'inspect_resources',
    category: 'assistant',
    description: 'Read the live state of Kubernetes objects (pods, deployments, services, pvc, nodes). Read-only.',
    usageGuidance: 'Use verb "get" or "describe" to inspect status, pending reasons, or PVC bindings.',
    compactGuidance: 'Read-only k8s resource inspector.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'get or describe.', enum: ['get', 'describe'] },
        resource: { type: 'string', description: 'pods, deployments, services, pvc, events, nodes, etc.' },
        target: { type: 'string', description: 'Deployment name or namespace.' },
        name: { type: 'string', description: 'Specific object name.' },
      },
      required: ['verb', 'resource'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_cluster_capacity',
    name: 'cluster_capacity',
    category: 'assistant',
    description: 'What the cluster has left: node CPU/memory usage and pressure conditions.',
    usageGuidance: 'Call when wondering why pods cannot schedule or why things run slowly.',
    compactGuidance: 'Check node CPU, memory, and pressure.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional deployment to inspect.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_infrastructure',
    name: 'list_infrastructure',
    category: 'assistant',
    description: 'What is running in the cluster (databases, storage, platform services) and what can be deployed.',
    usageGuidance: 'Call before proposing backing services or when checking if a database or platform service is running.',
    compactGuidance: 'List running backing services and deployable specs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_add_project_dependency',
    name: 'add_project_dependency',
    category: 'assistant',
    description: 'Declare that an existing project depends on a running backing service.',
    usageGuidance: 'Binds a project to a running database or cache reported by list_infrastructure.',
    compactGuidance: 'Bind project to running backing service.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project that needs it.' },
        service: { type: 'string', description: 'The running service name to depend on.' },
        as: { type: 'string', description: 'Optional directory name under $SERVICE_BINDING_ROOT.' },
      },
      required: ['projectId', 'service'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_propose_spec',
    name: 'propose_spec',
    category: 'assistant',
    description: 'Propose a new deployable backing service specification (database, cache, queue).',
    usageGuidance: 'Use when the user needs an infrastructure type not in list_infrastructure.',
    compactGuidance: 'Propose new backing service app spec.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Lowercase name, e.g. "redis".' },
        image: { type: 'string', description: 'Container image with tag.' },
        ports: { type: 'array', items: { type: 'object' }, description: 'Port definitions.' },
        resources: { type: 'object', description: 'Limits and requests.' },
      },
      required: ['id', 'image', 'ports', 'resources'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_request_escalated_privileges',
    name: 'request_escalated_privileges',
    category: 'assistant',
    description: 'Request elevated access to cluster-wide system namespaces (monitoring, gitea, kube-system) or administrator privileges.',
    usageGuidance: 'Call this when you need to inspect cluster system services (Prometheus, Grafana, Loki, Gitea) or diagnose nodes outside user tenancy. State a clear, honest reason.',
    compactGuidance: 'Request elevated cluster privileges.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Clear explanation of why elevated access is required.' },
        scope: { type: 'string', description: 'Requested privilege scope.', enum: ['cluster-read', 'cluster-admin'] },
        namespaces: { type: 'array', items: { type: 'string' }, description: 'Specific system namespaces requested (e.g. ["monitoring", "gitea"]).' },
      },
      required: ['reason', 'scope'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_mcp_servers',
    name: 'list_mcp_servers',
    category: 'assistant',
    description: 'Detail on the MCP services deployed under your account — tools exposed and readiness.',
    usageGuidance: 'Call when you need to know what tools an MCP service offers before deciding whether to enable it.',
    compactGuidance: 'List deployed MCP services and exposed tools.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Re-check every service live.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_enable_mcp_server',
    name: 'enable_mcp_server',
    category: 'assistant',
    description: 'Hook up a deployed MCP service, loading its tools immediately into this conversation.',
    usageGuidance: 'Enable a service when you need its tools. Its tools become available immediately in this same reply.',
    compactGuidance: 'Attach MCP service and load its tools.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The service name as listed in your prompt.' },
      },
      required: ['name'],
    },
    isBuiltIn: true,
  },

  // ── WEB TOOLS ──
  {
    id: 'tool_web_search',
    name: 'web_search',
    category: 'web',
    description: 'Search the open web using SearXNG. Returns titles, URLs, and text snippets.',
    usageGuidance: 'Use when looking up library documentation, API contracts, or current error messages.',
    compactGuidance: 'Search web for docs/APIs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query keywords.' },
      },
      required: ['query'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_fetch_web_page',
    name: 'fetch_web_page',
    category: 'web',
    description: 'Fetch the markdown text content of a web page by URL.',
    usageGuidance: 'Use after web_search to read full documentation pages or specifications.',
    compactGuidance: 'Fetch markdown of web URL.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
      },
      required: ['url'],
    },
    isBuiltIn: true,
  },

  // ── SANDBOX EXECUTION TOOLS ──
  {
    id: 'read_file_tool',
    name: 'read_file',
    category: 'sandbox',
    description: 'Read the text content of a file from the sandbox filesystem (/work).',
    usageGuidance: 'Inspect existing code or configuration before modifying it.',
    compactGuidance: 'Read file from /work sandbox.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from /work, e.g. "src/index.js".' },
      },
      required: ['path'],
    },
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
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from /work, e.g. "auth.js".' },
        content: { type: 'string', description: 'The text content to write.' },
      },
      required: ['path', 'content'],
    },
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
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string, e.g. "npm test".' },
      },
      required: ['command'],
    },
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
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line summary of what was accomplished.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'test_runner_tool',
    name: 'run_tests',
    category: 'sandbox',
    description: 'Execute unit tests (Vitest/Jest/Pytest/Go test) in the sandbox and return failing assertions.',
    usageGuidance: 'Run tests to verify code changes before finishing.',
    compactGuidance: 'Run unit test suite in sandbox.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional file pattern filter, e.g. "auth.test.js".' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'git_diff_inspector',
    name: 'inspect_git_diff',
    category: 'git',
    description: 'Inspect current uncommitted diffs and staged changes against the base branch in the sandbox.',
    usageGuidance: 'Check your modifications before concluding work.',
    compactGuidance: 'Inspect uncommitted git diffs in sandbox.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        stagedOnly: { type: 'boolean', description: 'Set true to inspect only staged changes.' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'http_request_tester',
    name: 'test_http_endpoint',
    category: 'http',
    description: 'Execute an HTTP request against a local running service port inside the sandbox.',
    usageGuidance: 'Verify that an HTTP server responds correctly to requests.',
    compactGuidance: 'Execute local HTTP request in sandbox.',
    requiresBinaries: ['curl'],
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'URL path, e.g. "/health".' },
        port: { type: 'number', description: 'Port number, e.g. 3000.' },
        body: { type: 'string', description: 'Optional payload.' },
      },
      required: ['method', 'path'],
    },
    isBuiltIn: true,
  },
  {
    id: 'linter_audit_tool',
    name: 'run_linter_audit',
    category: 'linter',
    description: 'Run static code analysis or linter check on sandbox files and return structured warnings.',
    usageGuidance: 'Check code quality and type compliance.',
    compactGuidance: 'Run static linter analysis.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        targetDir: { type: 'string', description: 'Directory path relative to /work, e.g. "src".' },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'db_query_tool',
    name: 'query_in_memory_db',
    category: 'database',
    description: 'Execute a read/write query against an in-memory test database instance in the sandbox.',
    usageGuidance: 'Verify test database state in sandbox runs.',
    compactGuidance: 'Query in-memory test database.',
    requiresBinaries: ['node'],
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection or table name.' },
        query: { type: 'string', description: 'JSON query payload string.' },
      },
      required: ['collection', 'query'],
    },
    isBuiltIn: true,
  },
  {
    id: 'save_harness_memory_tool',
    name: 'save_harness_memory',
    category: 'sandbox',
    description: 'Record a persistent lesson learned, environment fact, or prompt guidance rule into the Memory Bank.',
    usageGuidance: 'Preserve key findings or patterns learned during execution.',
    compactGuidance: 'Record lesson/fact into Memory Bank.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'] },
        title: { type: 'string', description: 'Short descriptive title.' },
        text: { type: 'string', description: 'Detailed insight or fact.' },
        suggestedScope: { type: 'string', enum: ['project', 'global'] },
      },
      required: ['category', 'title', 'text'],
    },
    isBuiltIn: true,
  },

  // ── CORE PLANNING TOOLS ──
  {
    id: 'list_leaves_tool',
    name: 'list_leaves',
    category: 'planning',
    description: 'List work items (leaves) already tracked on this branch to avoid duplicating work.',
    usageGuidance: 'Check existing leaves before proposing new tasks.',
    compactGuidance: 'List tracked work leaves on branch.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['proposed', 'pending', 'running', 'succeeded', 'failed', 'cancelled'] },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'get_leaf_tool',
    name: 'get_leaf',
    category: 'planning',
    description: 'Fetch full detail of a leaf: description, sub-items, and failed attempt error logs.',
    usageGuidance: 'Read full leaf specifications and test output.',
    compactGuidance: 'Fetch detailed leaf specification and logs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'propose_leaf_tool',
    name: 'propose_leaf',
    category: 'planning',
    description: 'Propose a new piece of work as a PROPOSAL on this branch.',
    usageGuidance: 'Propose an atomic, concrete unit of engineering work on the current branch.',
    compactGuidance: 'Propose new leaf on current branch.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title.' },
        body: { type: 'string', description: 'What doing this involves.' },
        parentLeafId: { type: 'string', description: 'Optional parent leaf id.' },
        language: { type: 'string', enum: ['node', 'python', 'go', 'base'] },
      },
      required: ['title'],
    },
    isBuiltIn: true,
  },
  {
    id: 'revise_leaf_tool',
    name: 'revise_leaf',
    category: 'planning',
    description: 'Change the title or description of a proposed leaf.',
    usageGuidance: 'Refine or clarify a proposed task.',
    compactGuidance: 'Update proposed leaf title/body.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        title: { type: 'string', description: 'Replacement title.' },
        body: { type: 'string', description: 'Replacement description.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'withdraw_leaf_tool',
    name: 'withdraw_leaf',
    category: 'planning',
    description: 'Withdraw a leaf proposal that is no longer needed.',
    usageGuidance: 'Remove duplicate or obsolete proposals.',
    compactGuidance: 'Withdraw unneeded leaf proposal.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        reason: { type: 'string', description: 'Reason for withdrawal.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_leaf_workspace_tool',
    name: 'set_leaf_workspace',
    category: 'planning',
    description: 'Change which toolchain a leaf runs in (node, python, go, base).',
    usageGuidance: 'Configure execution container language for a leaf.',
    compactGuidance: 'Set toolchain language for leaf.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        language: { type: 'string', enum: ['node', 'python', 'go', 'base'] },
      },
      required: ['id', 'language'],
    },
    isBuiltIn: true,
  },
  {
    id: 'list_projects_tool',
    name: 'list_projects',
    category: 'planning',
    description: 'List registered git repositories for the current user.',
    usageGuidance: 'Find existing git repos to attach leaves to.',
    compactGuidance: 'List registered user git repositories.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'create_project_tool',
    name: 'create_project',
    category: 'planning',
    description: 'Create a new private git repository for the user.',
    usageGuidance: 'Create a git repository in Gitea for project code.',
    compactGuidance: 'Create private git repository.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short repository name.' },
        description: { type: 'string', description: 'One-line description.' },
      },
      required: ['name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_leaf_project_tool',
    name: 'set_leaf_project',
    category: 'planning',
    description: 'Attach a leaf to a git repository project.',
    usageGuidance: 'Bind a leaf to a specific git repository for code commits.',
    compactGuidance: 'Attach leaf to git repository project.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        projectId: { type: 'string', description: 'The project id.' },
      },
      required: ['id', 'projectId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'request_secret_tool',
    name: 'request_secret',
    category: 'assistant',
    description: 'Request a sensitive credential, token, or API key from the user via a secure interactive UI card. The secret is encrypted and vaulted directly in Infisical without appearing in chat logs.',
    usageGuidance: 'Call this tool whenever an application requires a sensitive token, API key, or password. NEVER ask the user to type sensitive credentials into chat text. Once the user submits the secret, write the application code to read it via standard environment variables (process.env.<KEY>), and inject it into the pod with inject_secret_to_pod.',
    compactGuidance: 'Prompt user with secure modal to vault a token or API key directly into Infisical.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The environment variable or secret key name (e.g. GITHUB_TOKEN, STRIPE_SECRET_KEY, OPENAI_API_KEY).' },
        label: { type: 'string', description: 'Human-friendly title for the card (e.g. "GitHub Personal Access Token").' },
        description: { type: 'string', description: 'Detailed explanation of why this secret is needed, required scopes, and where to obtain it.' },
        projectId: { type: 'string', description: 'Optional target project ID to associate this secret with.' },
      },
      required: ['key', 'description'],
    },
    isBuiltIn: true,
  },
  {
    id: 'inject_secret_to_pod_tool',
    name: 'inject_secret_to_pod',
    category: 'assistant',
    description: 'Inject a vaulted secret into a deployed project pod via Kubernetes Secret (<app>-secrets) as an environment variable or file, and trigger a rolling restart.',
    usageGuidance: 'Mounts a vaulted Infisical secret reference into the target pod\'s Kubernetes Secret as a standard environment variable accessible to the application runtime, and restarts the pod.',
    compactGuidance: 'Inject vaulted secret into pod as env var and trigger rolling restart.',
    requiresBinaries: ['kubectl'],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Target project ID.' },
        key: { type: 'string', description: 'Secret key name to inject (e.g. GITHUB_TOKEN).' },
        secretReference: { type: 'string', description: 'Optional Infisical vault reference URI (e.g. secret://project/GITHUB_TOKEN).' },
        mountAs: { type: 'string', enum: ['env', 'file'], description: 'How to mount the secret in the pod ("env" for environment variable, "file" for file mount, defaults to "env").' },
        restart: { type: 'boolean', description: 'Whether to trigger a zero-downtime rolling pod restart immediately (defaults to true).' },
      },
      required: ['projectId', 'key'],
    },
    isBuiltIn: true,
  },
  {
    id: 'get_project_secret_tool',
    name: 'get_project_secret',
    category: 'assistant',
    description: 'Retrieve metadata and vault reference for a project secret in Infisical.',
    usageGuidance: 'Check whether a secret key is already vaulted for a project.',
    compactGuidance: 'Retrieve secret metadata from Infisical vault.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID.' },
        key: { type: 'string', description: 'Secret key name.' },
      },
      required: ['projectId', 'key'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_project_secret_tool',
    name: 'set_project_secret',
    category: 'assistant',
    description: 'Set or update a secret in a project\'s Infisical vault.',
    usageGuidance: 'Store or update an encrypted secret in Infisical. Returns a vault reference URI.',
    compactGuidance: 'Save encrypted secret in Infisical vault.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID.' },
        key: { type: 'string', description: 'Secret key name.' },
        value: { type: 'string', description: 'Secret plaintext value to encrypt and vault.' },
        comment: { type: 'string', description: 'Optional explanation of secret usage.' },
      },
      required: ['projectId', 'key', 'value'],
    },
    isBuiltIn: true,
  },
  {
    id: 'list_project_secrets_tool',
    name: 'list_project_secrets',
    category: 'assistant',
    description: 'List configured secret keys in Infisical for a project with masked previews (never raw plaintext).',
    usageGuidance: 'List all vaulted secrets for a project. Values are masked for security.',
    compactGuidance: 'List project secrets with masked values.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID.' },
      },
      required: ['projectId'],
    },
    isBuiltIn: true,
  },
];

/** Minimal database interface needed for seeding tools. */
export interface ToolSeedStore {
  getTools(): Promise<ToolRepositoryItem[]>;
  saveTool(tool: ToolRepositoryItem): Promise<void>;
}

/**
 * Idempotently seed or update all built-in platform tools in MongoDB.
 *
 * Updates built-in tools when code definitions change; preserves user-created custom tools.
 */
export async function seedTools(store: ToolSeedStore): Promise<number> {
  const existing = await store.getTools();
  const existingMap = new Map(existing.map((t) => [t.name, t]));
  let seededCount = 0;

  for (const seed of TOOL_SEEDS) {
    const prev = existingMap.get(seed.name);
    // If tool does not exist, or exists as built-in, upsert with latest schema and guidance
    if (!prev || prev.isBuiltIn !== false) {
      await store.saveTool({
        ...seed,
        id: prev?.id ?? seed.id,
      });
      seededCount++;
    }
  }

  return seededCount;
}
