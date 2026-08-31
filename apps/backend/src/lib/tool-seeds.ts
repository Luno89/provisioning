import type { ToolEffect } from './action-gate.js';

export type ToolSurface = 'assistant' | 'planning' | 'sandbox';

export interface ToolRepositoryItem {
  id: string;
  name: string;
  ownerId?: string;
  effect?: ToolEffect;
  /**
   * Which runtimes offer this tool. A tool can be on two surfaces at once — `list_mcp_servers` is
   * offered to a chat and to a planner — which is why `category` cannot carry this.
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
    category: 'assistant',
    effect: 'propose',
    surfaces: ['assistant'],
    description: 'Propose a PROJECT to build. It is created as a proposal for a human to accept — calling this starts nothing and creates nothing. Propose one when the work is clear enough to name and describe; ask a question instead when it is not. One project per separately deliverable thing, not one per step of building it.',
    usageGuidance: 'Use this ONLY when creating a brand-new project from scratch. NEVER call this to fix, configure, or redeploy an existing project.',
    compactGuidance: 'Propose brand new project only; never use for existing project fixes.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name for the project, e.g. "GitHub API MCP".',
        },
        type: {
          type: 'string',
          description: 'What kind of thing this is. Call list_tree_types to see the ids available.',
        },
        goal: {
          type: 'string',
          description: 'What done looks like, in a sentence or two. This is what the planner reads when the project is opened, so write what someone would need to know without this conversation.',
        },
      },
      required: ['name', 'goal'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_trees',
    name: 'list_trees',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'The projects that already exist, with how their work is going. Call this before proposing anything, so you extend what is there instead of proposing a second copy of it — and to answer questions about how something is coming along.',
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
    effect: 'read',
    surfaces: ['assistant'],
    description: 'Check the CI/CD pipeline runs, latest commit SHA, built container image tag, and Kaniko build status for a project. Answers whether an image has been built from the project\'s code.',
    usageGuidance: 'Call this to check if a project\'s code has been built by Kaniko, verify image tags, or inspect build failures before deploying.',
    compactGuidance: 'Inspect CI/CD build runs and image tag.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to inspect.',
        },
        name: {
          type: 'string',
          description: 'Project name to inspect, if ID is not known.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_env',
    name: 'get_project_env',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'View the currently configured runtime environment variables (deployEnv) for an existing project.',
    usageGuidance: 'Inspect current environment variables and service bindings configured on a project before deploying or when troubleshooting credentials.',
    compactGuidance: 'View project runtime env variables.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to inspect.',
        },
        name: {
          type: 'string',
          description: 'Project name to inspect, if ID is not known.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_set_project_env',
    name: 'set_project_env',
    category: 'assistant',
    effect: 'write',
    surfaces: ['assistant'],
    description: 'Set or update runtime environment variables (e.g. GITEA_URL, GITEA_TOKEN, API keys) on an existing project.',
    usageGuidance: 'Call this to supply needed credentials or URLs before calling deploy_project. Format variables as KEY=VALUE lines or key-value object.',
    compactGuidance: 'Configure runtime env variables on project.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to configure.',
        },
        name: {
          type: 'string',
          description: 'Project name to configure, if ID is not known.',
        },
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
    effect: 'write',
    surfaces: ['assistant'],
    description: 'Promote and deploy a project\'s built container image to its target Kubernetes cluster. Use this when the project has built successfully and needs to be deployed as a running service.',
    usageGuidance: 'Use this to deploy or redeploy a project after code builds or environment variables are updated. Do NOT use propose_tree to redeploy.',
    compactGuidance: 'Promote and deploy project container image.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to deploy.',
        },
        name: {
          type: 'string',
          description: 'Project name to deploy, if ID is not known.',
        },
        runId: {
          type: 'string',
          description: 'Specific pipeline run ID to promote, if not latest.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_url',
    name: 'get_project_url',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'Get the live reachable URL, listening port, cluster namespace, and health status for a deployed project.',
    usageGuidance: 'Call this to find the live endpoint and port for a deployed application.',
    compactGuidance: 'Get live URL and health of deployed project.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID.',
        },
        name: {
          type: 'string',
          description: 'Project name.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_logs',
    name: 'get_logs',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'The recent output of a deployment, for working out WHY it is not working. Read this before saying what is wrong with something in `broken` — the cause is almost always in the last few lines, and guessing from the app name sends the fix in the wrong direction.',
    usageGuidance: 'ALWAYS check container logs before diagnosing why a pod or service is in CrashLoopBackOff. Do not guess root causes from app names.',
    compactGuidance: 'Retrieve container stdout/stderr logs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        deployment: {
          type: 'string',
          description: 'The deployment name, as reported by list_infrastructure.',
        },
      },
      required: ['deployment'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_events',
    name: 'get_events',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'Recent Kubernetes events for a deployment. Answers the failures logs cannot: an image that will not pull, a volume that never bound, a pod that was never scheduled. Use it when get_logs is empty — a container that never started has no output.',
    usageGuidance: 'Call this when get_logs is empty or when pods fail to start or schedule.',
    compactGuidance: 'Inspect k8s pod/deployment events.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        deployment: {
          type: 'string',
          description: 'The deployment name, as reported by list_infrastructure.',
        },
      },
      required: ['deployment'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_inspect_resources',
    name: 'inspect_resources',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'Read the live state of Kubernetes objects belonging to one of your deployments or leaf sandboxes — `get` for a list, `describe` for the detail including events and why a pod is pending. Use it when get_logs is empty or the cause is not in the output: a pod that never scheduled, a volume that never bound, a container stuck pulling. Read-only.',
    usageGuidance: 'Use verb "get" or "describe" to inspect status, pending reasons, or PVC bindings.',
    compactGuidance: 'Read-only k8s resource inspector.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        verb: {
          type: 'string',
          description: 'get or describe.',
          enum: ['get', 'describe'],
        },
        resource: {
          type: 'string',
          description: 'pods, deployments, services, pvc, events, replicasets, jobs, ingress, nodes.',
        },
        target: {
          type: 'string',
          description: 'The deployment name from list_infrastructure, or a leaf id to look at its sandbox. Not needed for cluster-wide resources like nodes.',
        },
        name: {
          type: 'string',
          description: 'One specific object, optional.',
        },
      },
      required: ['verb', 'resource'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_cluster_capacity',
    name: 'cluster_capacity',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'What the cluster has left: node CPU and memory usage, and node conditions such as disk or memory pressure. The question behind "why is everything slow" and "why will nothing schedule" — both of which look like application bugs from inside a single deployment.',
    usageGuidance: 'Call when wondering why pods cannot schedule or why things run slowly.',
    compactGuidance: 'Check node CPU, memory, and pressure.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Optional deployment or leaf sandbox, to see its pods\' usage instead of nodes.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_infrastructure',
    name: 'list_infrastructure',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant', 'planning'],
    description: 'What is running in the cluster that a built service could use — databases, storage, search, embeddings — with the address a pod reaches each one at, and the full list of what this platform can deploy. Call this BEFORE proposing work that depends on a piece of infrastructure. Anything absent from both lists does not exist here and cannot be built: say so rather than planning around it. Never hard-code an address into a leaf — a service a project depends on is provided to it as a binding at deploy time, read from $SERVICE_BINDING_ROOT at runtime.',
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
    effect: 'write',
    surfaces: ['assistant', 'planning'],
    description: 'Declare that an existing project depends on a running service, so its deployment is given the address and credentials for it. Use the projectId reported by list_mcp_servers or list_trees. Call this before proposing work that connects to something — the work then reads the connection from $SERVICE_BINDING_ROOT at runtime rather than being told it now. The service must be one list_infrastructure reports. Nothing is deployed by this — the binding is provided the next time that project deploys.',
    usageGuidance: 'Binds a project to a running database or cache reported by list_infrastructure.',
    compactGuidance: 'Bind project to running backing service.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The project that needs it, from list_projects.',
        },
        service: {
          type: 'string',
          description: 'The running service to depend on, by name.',
        },
        as: {
          type: 'string',
          description: 'Optional directory name under $SERVICE_BINDING_ROOT. Defaults to the service type; give one only when a project needs two of the same kind.',
        },
      },
      required: ['projectId', 'service'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_propose_spec',
    name: 'propose_spec',
    category: 'assistant',
    effect: 'propose',
    surfaces: ['assistant'],
    description: 'Propose a new deployable app type, so this platform can deploy something it currently cannot — a database, a cache, a queue. It is created as a PROPOSAL for a human to accept; nothing is deployed and nothing is added to the catalogue by calling this. Check list_infrastructure first: if it is already deployable, propose nothing.',
    usageGuidance: 'Use when the user needs an infrastructure type not in list_infrastructure.',
    compactGuidance: 'Propose new backing service app spec.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Lowercase name, e.g. "mongo". Becomes the namespace, Service name and DNS label.',
        },
        image: {
          type: 'string',
          description: 'Container image with a tag, e.g. "mongo:7".',
        },
        args: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Optional container arguments.',
        },
        ports: {
          type: 'array',
          description: 'At least one. Services target ports by name, so each needs one.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
              },
              port: {
                type: 'number',
              },
            },
            required: ['name', 'port'],
          },
        },
        env: {
          type: 'array',
          description: 'Environment variables. For a credential use `generate` with `fromSecret` and give NO value — the platform mints it and injects it from a Secret, and you never see it. Never write a password here.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
              },
              value: {
                type: 'string',
              },
              fromSecret: {
                type: 'string',
                description: 'Secret key a generated value is read from.',
              },
              generate: {
                type: 'string',
                enum: ['password', 'username'],
              },
            },
            required: ['name'],
          },
        },
        volumes: {
          type: 'array',
          description: 'Persistent disks. Anything that stores data needs one, or it is lost on restart.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
              },
              size: {
                type: 'string',
              },
            },
            required: ['path', 'size'],
          },
        },
        resources: {
          type: 'object',
          description: 'REQUIRED. Both limits must be given — an app with no memory limit can take a node down and evict everything on it.',
          properties: {
            limits: {
              type: 'object',
              properties: {
                cpu: {
                  type: 'string',
                },
                memory: {
                  type: 'string',
                },
              },
              required: ['cpu', 'memory'],
            },
            requests: {
              type: 'object',
              properties: {
                cpu: {
                  type: 'string',
                },
                memory: {
                  type: 'string',
                },
              },
            },
          },
          required: ['limits'],
        },
        liveness: {
          type: 'object',
          description: 'An HTTP health check, when the app has one. Omit for anything that does not speak HTTP.',
          properties: {
            path: {
              type: 'string',
            },
            port: {
              type: 'number',
            },
          },
          required: ['path', 'port'],
        },
        ingressPort: {
          type: 'number',
          description: 'Only if a person would open this in a browser. Omit for databases and caches.',
        },
      },
      required: ['id', 'image', 'ports', 'resources'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_request_escalated_privileges',
    name: 'request_escalated_privileges',
    category: 'assistant',
    effect: 'propose',
    surfaces: ['assistant'],
    description: 'Request elevated access to cluster-wide system namespaces (monitoring, gitea, kube-system) or administrator privileges when diagnosing platform infrastructure. State a clear, honest reason.',
    usageGuidance: 'Call this when you need to inspect cluster system services (Prometheus, Grafana, Loki, Gitea) or diagnose nodes outside user tenancy. State a clear, honest reason.',
    compactGuidance: 'Request elevated cluster privileges.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why elevated access is required.',
        },
        scope: {
          type: 'string',
          description: 'Requested privilege scope.',
          enum: ['cluster-read', 'cluster-admin'],
        },
        namespaces: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Specific system namespaces requested (e.g. ["monitoring", "gitea"]).',
        },
      },
      required: ['reason', 'scope'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_mcp_servers',
    name: 'list_mcp_servers',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant', 'planning'],
    description: 'List the MCP servers deployed under your account, the tools each one exposes, and whether each is answering. These are real, running services — including ones built here — and a leaf that names a server in its body can call its tools while it runs. The names alone are already in your prompt: call this when you need to know what a service can DO, before deciding whether to hook one up or planning work that needs a capability, to find out whether it already exists. Each server also reports the projectId of the repository it is built from, so an existing server can be EXTENDED with set_leaf_project rather than replaced by a second one.',
    usageGuidance: 'Call when you need to know what tools an MCP service offers before deciding whether to enable it.',
    compactGuidance: 'List deployed MCP services and exposed tools.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Re-introspect every server instead of using the cached tool list. Use after deploying or redeploying one, when its tools may have changed.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_enable_mcp_server',
    name: 'enable_mcp_server',
    category: 'assistant',
    effect: 'write',
    surfaces: ['assistant'],
    description: 'Hook up one of the services listed in your prompt, loading its tools so you can call them. They become available IMMEDIATELY — in this same reply — so you can enable a service and then use it without waiting for the user to say anything. Enable one when you need it, not in advance.',
    usageGuidance: 'Enable a service when you need its tools. Its tools become available immediately in this same reply.',
    compactGuidance: 'Attach MCP service and load its tools.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The service name, exactly as listed in your prompt.',
        },
      },
      required: ['name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_web_search',
    name: 'web_search',
    category: 'web',
    effect: 'read',
    surfaces: ['assistant', 'planning'],
    description: 'Search the live web for current information, documentation, package versions, or technical articles. Be specific — a search engine needs precise terms, not whole sentences. Include version numbers, library names, and error codes.',
    usageGuidance: 'Use when looking up library documentation, API contracts, or current error messages. If the result set is empty, try different terms before reporting nothing exists.',
    compactGuidance: 'Search web for docs/APIs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web.',
        },
      },
      required: ['query'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_fetch_web_page',
    name: 'fetch_web_page',
    category: 'web',
    effect: 'read',
    surfaces: ['assistant', 'planning'],
    description: 'Fetch and extract clean text content from a web page URL.',
    usageGuidance: 'Use after web_search to read full documentation pages or specifications.',
    compactGuidance: 'Fetch markdown of web URL.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The HTTP or HTTPS URL to fetch.',
        },
      },
      required: ['url'],
    },
    isBuiltIn: true,
  },
  {
    id: 'read_file_tool',
    name: 'read_file',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Read a file back out of the sandbox.',
    usageGuidance: 'Inspect existing code or configuration before modifying it.',
    compactGuidance: 'Read file from /work sandbox.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to /work.',
        },
      },
      required: ['path'],
    },
    isBuiltIn: true,
  },
  {
    id: 'write_file_tool',
    name: 'write_file',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Write a file, creating parent directories as needed. Replaces the whole file. Use this rather than shell heredocs, which mangle quotes and backticks.',
    usageGuidance: 'Write complete, fully-implemented code. Never write placeholders or TODOs.',
    compactGuidance: 'Create/overwrite file in /work sandbox.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to /work, e.g. "src/index.ts".',
        },
        content: {
          type: 'string',
          description: 'The complete new contents of the file.',
        },
      },
      required: ['path', 'content'],
    },
    isBuiltIn: true,
  },
  {
    id: 'run_command_tool',
    name: 'run_command',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Run a shell command in the sandbox and get back stdout, stderr and the exit code. Each call is a FRESH shell — `cd` and environment variables do not persist, so chain steps with && or use absolute paths.',
    usageGuidance: 'Run builds, tests, or scripts inside the isolated sandbox.',
    compactGuidance: 'Execute bash command in sandbox.',
    requiresBinaries: ['bash'],
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command, e.g. "cd /work/app && npm test".',
        },
      },
      required: ['command'],
    },
    isBuiltIn: true,
  },
  {
    id: 'finish_tool',
    name: 'finish',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Call this when the task is complete, or when you are certain you cannot complete it. This ends the attempt — nothing runs afterwards, so verify your work BEFORE calling it.',
    usageGuidance: 'Call when all work is done and tests have verified success.',
    compactGuidance: 'Signal task completion.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        succeeded: {
          type: 'boolean',
          description: 'true if the task is done, false if you are stuck.',
        },
        summary: {
          type: 'string',
          description: 'What you did, or why you could not. If you failed, be specific — this is the only thing the next attempt will know about this one.',
        },
      },
      required: ['succeeded', 'summary'],
    },
    isBuiltIn: true,
  },
  {
    id: 'test_runner_tool',
    name: 'run_tests',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Execute unit tests (Vitest/Jest/Pytest/Go test) in the sandbox and return failing assertions.',
    usageGuidance: 'Run tests to verify code changes before finishing.',
    compactGuidance: 'Run unit test suite in sandbox.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The test command to run, e.g. "npm test", "pytest", "go test ./...". Defaults to "npm test".',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'git_diff_inspector',
    name: 'inspect_git_diff',
    category: 'git',
    surfaces: ['sandbox'],
    description: 'Inspect current uncommitted diffs and staged changes against the base branch in the sandbox.',
    usageGuidance: 'Check your modifications before concluding work.',
    compactGuidance: 'Inspect uncommitted git diffs in sandbox.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'http_request_tester',
    name: 'test_http_endpoint',
    category: 'http',
    surfaces: ['sandbox'],
    description: 'Execute an HTTP request against a local running service port inside the sandbox.',
    usageGuidance: 'Verify that an HTTP server responds correctly to requests.',
    compactGuidance: 'Execute local HTTP request in sandbox.',
    requiresBinaries: ['curl'],
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to request, e.g. "http://localhost:8080/health". Defaults to http://localhost:8080.',
        },
        method: {
          type: 'string',
          description: 'HTTP method. Defaults to GET.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'linter_audit_tool',
    name: 'run_linter_audit',
    category: 'linter',
    surfaces: ['sandbox'],
    description: 'Run static code analysis or linter check on sandbox files and return structured warnings.',
    usageGuidance: 'Check code quality and type compliance.',
    compactGuidance: 'Run static linter analysis.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory to lint, relative to the workspace root. Defaults to the whole tree.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'db_query_tool',
    name: 'query_in_memory_db',
    category: 'database',
    surfaces: ['sandbox'],
    description: 'Execute a read/write query against an in-memory test database instance in the sandbox.',
    usageGuidance: 'Verify test database state in sandbox runs.',
    compactGuidance: 'Query in-memory test database.',
    requiresBinaries: ['node'],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The query to run against the in-memory test database.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'save_harness_memory_tool',
    name: 'save_harness_memory',
    category: 'sandbox',
    surfaces: ['sandbox'],
    description: 'Record a persistent lesson learned, environment fact, or prompt guidance rule into the Memory Bank.',
    usageGuidance: 'Preserve key findings or patterns learned during execution.',
    compactGuidance: 'Record lesson/fact into Memory Bank.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'],
          description: 'What kind of memory this is. Defaults to lessons_learned.',
        },
        title: {
          type: 'string',
          description: 'Short name for the lesson, e.g. "npm ci needs a lockfile".',
        },
        text: {
          type: 'string',
          description: 'The lesson itself, written so it is useful to a run that has none of this context.',
        },
        suggestedScope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Whether this applies to this project only, or everywhere. Defaults to project.',
        },
      },
      required: ['title', 'text'],
    },
    isBuiltIn: true,
  },
  {
    id: 'list_leaves_tool',
    name: 'list_leaves',
    category: 'planning',
    effect: 'read',
    surfaces: ['planning'],
    description: 'List the work items (leaves) already tracked on this branch. Call this before proposing anything, to avoid duplicating work that exists.',
    usageGuidance: 'Check existing leaves before proposing new tasks.',
    compactGuidance: 'List tracked work leaves on branch.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['proposed', 'pending', 'running', 'succeeded', 'failed', 'cancelled'],
          description: 'Only return leaves in this state. Omit for all.',
        },
      },
    },
    isBuiltIn: true,
  },
  {
    id: 'get_leaf_tool',
    name: 'get_leaf',
    category: 'planning',
    effect: 'read',
    surfaces: ['planning'],
    description: 'Full detail of one leaf: its description, its sub-items, and every failed attempt with the error. Use this when asked why something failed or what a leaf involves.',
    usageGuidance: 'Read full leaf specifications and test output.',
    compactGuidance: 'Fetch detailed leaf specification and logs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The leaf id, as returned by list_leaves.',
        },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'propose_leaf_tool',
    name: 'propose_leaf',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Propose a new piece of work. It is created as a PROPOSAL for a human to accept — calling this does not start any work. Propose one leaf per separately deliverable piece.',
    usageGuidance: 'Propose an atomic, concrete unit of engineering work on the current branch.',
    compactGuidance: 'Propose new leaf on current branch.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short imperative title, e.g. "Add a rate limit to /api/chat".',
        },
        body: {
          type: 'string',
          description: 'What doing this involves, in one or two sentences.',
        },
        parentLeafId: {
          type: 'string',
          description: 'Optional — the leaf this is a sub-item of.',
        },
        expects: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Optional — repository paths this work must leave behind, e.g. ["NOTES.md"] or ["src/client.js","test/client.test.js"]. Checked after the leaf runs: each must be committed and non-empty, or the leaf is marked failed. Give these for work that has no tests to run (research, documentation, configuration) — without them nothing can check that the work was actually produced. Use the file extension and directory layout this project actually uses — they are stated above. Do not guess .ts for a JavaScript project.',
        },
        dependsOn: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Optional — titles of leaves on this branch that must FINISH before this one starts. Use it whenever this work builds on another leaf\'s output: without it every leaf starts at the same time in its own empty sandbox, and later steps find nothing to build on. Give the titles exactly as you proposed them. The result confirms which ones were recorded and warns about any that matched no leaf — check it, because an unmatched title means this leaf will not wait after all.',
        },
        projectId: {
          type: 'string',
          description: 'Optional — the id of an existing project this work belongs in, from list_projects or the projectId reported by list_mcp_servers. Give it whenever the work CHANGES something that already exists: the leaf then checks out that repository, and merging rebuilds and redeploys it. Omit it for genuinely new work, which gets a repository of its own.',
        },
        mcp: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Optional — names of MCP servers this leaf must CALL while it runs, from list_mcp_servers. Give these whenever the work uses a deployed service: without them the leaf has no tools for it and can only guess at HTTP. A server built earlier in this same plan can be named here by the leaf that verifies it.',
        },
        persona: {
          type: 'string',
          description: 'REQUIRED — the name of the persona that will do this work, exactly as listed by list_personas. A persona decides the toolchain, what the work may reach on the network, which tools it can call, how long it gets and where its output goes. There is no default: a leaf with none assigned cannot run, and you will be asked again until one is set.',
        },
      },
      required: ['title'],
    },
    isBuiltIn: true,
  },
  {
    id: 'revise_leaf_tool',
    name: 'revise_leaf',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Change the title, description, or assigned persona of a leaf that is still a PROPOSAL. Use this when asked to reword something already proposed, or to say who should do it, instead of proposing a near-duplicate. Accepted or running work cannot be edited.',
    usageGuidance: 'Refine or clarify a proposed task.',
    compactGuidance: 'Update proposed leaf title/body.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The leaf id, as returned by list_leaves.',
        },
        title: {
          type: 'string',
          description: 'Replacement title. Omit to leave it alone.',
        },
        body: {
          type: 'string',
          description: 'Replacement description. Omit to leave it alone.',
        },
        persona: {
          type: 'string',
          description: 'The name of the persona that should do this work, exactly as listed. A persona decides the toolchain, what the work may reach on the network, which tools it can call and how long it gets — work with none assigned cannot run.',
        },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'withdraw_leaf_tool',
    name: 'withdraw_leaf',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Withdraw a PROPOSAL you no longer stand behind — a duplicate, or something the user ruled out. Only works while it is still a proposal; accepted work is the human\'s to cancel.',
    usageGuidance: 'Remove duplicate or obsolete proposals.',
    compactGuidance: 'Withdraw unneeded leaf proposal.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The leaf id, as returned by list_leaves.',
        },
        reason: {
          type: 'string',
          description: 'Why, in a few words. Shown to the user.',
        },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'list_projects_tool',
    name: 'list_projects',
    category: 'planning',
    effect: 'read',
    surfaces: ['planning'],
    description: 'List the git repositories this user has registered. Call this before creating one, and before attaching work to a project, so you use an existing repository rather than a new one.',
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
    effect: 'write',
    surfaces: ['planning'],
    description: 'Create a new private git repository for this user. Use it only when the work needs a repository that does not exist yet — check list_projects first. The repository belongs to the user you are talking to; you cannot see or touch anyone else\'s.',
    usageGuidance: 'Create a git repository in Gitea for project code.',
    compactGuidance: 'Create private git repository.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name, e.g. "invoice-parser". Lowercased and hyphenated automatically.',
        },
        description: {
          type: 'string',
          description: 'One line on what it is for.',
        },
        language: {
          type: 'string',
          enum: ['node', 'python', 'go', 'base'],
          description: 'What this project is written in, so every persona working in it gets the right toolchain. Defaults to "node". "node": Node.js 22 + npm. Also has Python 3.9, gcc and make. "python": Python 3.12 + pip and venv. Also has Node 22, gcc and make. "go": Go 1.26 toolchain. Also has Node 22, Python 3.9, gcc and make. "base": Minimal shell environment. No git, no compilers — shell and text editing only.',
        },
      },
      required: ['name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_leaf_project_tool',
    name: 'set_leaf_project',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Attach a leaf to a project, so the work is done against that repository — it is cloned into the sandbox, and the agent commits and pushes to a branch. Work with no project runs in an empty sandbox and is thrown away when it finishes.',
    usageGuidance: 'Bind a leaf to a specific git repository for code commits.',
    compactGuidance: 'Attach leaf to git repository project.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The leaf id, as returned by list_leaves.',
        },
        projectId: {
          type: 'string',
          description: 'The project id, as returned by list_projects.',
        },
      },
      required: ['id', 'projectId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'request_secret_tool',
    name: 'request_secret',
    category: 'assistant',
    effect: 'propose',
    surfaces: ['assistant'],
    description: 'Request a sensitive credential, token, or API key from the user via a secure interactive UI card. The secret is encrypted and vaulted directly in Infisical without appearing in chat logs.',
    usageGuidance: 'Call this tool whenever an application requires a sensitive token, API key, or password. NEVER ask the user to type sensitive credentials into chat text. Once the user submits the secret, write the application code to read it via standard environment variables (process.env.<KEY>), and inject it into the pod with inject_secret_to_pod.',
    compactGuidance: 'Prompt user with secure modal to vault a token or API key directly into Infisical.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The environment variable or secret key name (e.g. GITHUB_TOKEN, STRIPE_SECRET_KEY, OPENAI_API_KEY).',
        },
        label: {
          type: 'string',
          description: 'Human-friendly title for the card (e.g. "GitHub Personal Access Token").',
        },
        description: {
          type: 'string',
          description: 'Detailed explanation of why this secret is needed, required scopes, and where to obtain it.',
        },
        projectId: {
          type: 'string',
          description: 'Optional target project ID to associate this secret with.',
        },
      },
      required: ['key', 'description'],
    },
    isBuiltIn: true,
  },
  {
    id: 'inject_secret_to_pod_tool',
    name: 'inject_secret_to_pod',
    category: 'assistant',
    effect: 'write',
    surfaces: ['assistant'],
    description: 'Inject a vaulted secret into a deployed project pod via Kubernetes Secret (<app>-secrets) as an environment variable or file, and trigger a rolling restart.',
    usageGuidance: 'Mounts a vaulted Infisical secret reference into the target pod\'s Kubernetes Secret as a standard environment variable accessible to the application runtime, and restarts the pod.',
    compactGuidance: 'Inject vaulted secret into pod as env var and trigger rolling restart.',
    requiresBinaries: ['kubectl'],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Target project ID.',
        },
        key: {
          type: 'string',
          description: 'Secret key name to inject (e.g. GITHUB_TOKEN).',
        },
        secretReference: {
          type: 'string',
          description: 'Optional Infisical vault reference URI (e.g. secret://project/GITHUB_TOKEN).',
        },
        mountAs: {
          type: 'string',
          enum: ['env', 'file'],
          description: 'How to mount the secret in the pod ("env" for environment variable, "file" for file mount, defaults to "env").',
        },
        restart: {
          type: 'boolean',
          description: 'Whether to trigger a zero-downtime rolling pod restart immediately (defaults to true).',
        },
      },
      required: ['projectId', 'key'],
    },
    isBuiltIn: true,
  },
  {
    id: 'get_project_secret_tool',
    name: 'get_project_secret',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'Retrieve metadata and vault reference for a project secret in Infisical.',
    usageGuidance: 'Check whether a secret key is already vaulted for a project.',
    compactGuidance: 'Retrieve secret metadata from Infisical vault.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID.',
        },
        key: {
          type: 'string',
          description: 'Secret key name.',
        },
      },
      required: ['projectId', 'key'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_project_secret_tool',
    name: 'set_project_secret',
    category: 'assistant',
    effect: 'write',
    surfaces: ['assistant'],
    description: 'Set or update a secret in a project\'s Infisical vault.',
    usageGuidance: 'Store or update an encrypted secret in Infisical. Returns a vault reference URI.',
    compactGuidance: 'Save encrypted secret in Infisical vault.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID.',
        },
        key: {
          type: 'string',
          description: 'Secret key name.',
        },
        value: {
          type: 'string',
          description: 'Secret plaintext value to encrypt and vault.',
        },
        comment: {
          type: 'string',
          description: 'Optional explanation of secret usage.',
        },
      },
      required: ['projectId', 'key', 'value'],
    },
    isBuiltIn: true,
  },
  {
    id: 'list_project_secrets_tool',
    name: 'list_project_secrets',
    category: 'assistant',
    effect: 'read',
    surfaces: ['assistant'],
    description: 'List configured secret keys in Infisical for a project with masked previews (never raw plaintext).',
    usageGuidance: 'List all vaulted secrets for a project. Values are masked for security.',
    compactGuidance: 'List project secrets with masked values.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID.',
        },
      },
      required: ['projectId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_set_acceptance',
    name: 'set_acceptance',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Declare how we will know this request actually delivered. These checks run in order against the finished, merged result once every leaf is done, and the verdict goes to the user. Set this for any request that produces something — it is the only thing that proves the ASSEMBLED whole works, where per-leaf checks only prove each piece.\nChoose checks that fit what is being built:\n- Software: install dependencies, run the test suite, then RUN the thing the way the user described it — `node src/cli.js "Fall City, WA"`. The run is the important one; a test suite alone will happily pass while the entry point is still a stub.\n- Research or writing: check the deliverable exists and is substantial, and that its claims are traceable — for example that the write-up contains source links.\n- Configuration or infrastructure: check the file parses or validates with whatever tool reads it.\nEach check must exit non-zero when that aspect is broken, or it proves nothing.\nChecks already run from the repository root, so use paths relative to it and do NOT cd anywhere: write `node verify.js`, never `cd /work && node verify.js`.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'What this proves, in a few words — "tests pass", "prints an AQI", "cites sources".',
              },
              command: {
                type: 'string',
                description: 'A single command run from the repository root.',
              },
            },
            required: ['name', 'command'],
          },
          description: 'Ordered. The first one that fails is the one reported; later ones are not run.',
        },
      },
      required: ['checks'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_replace_leaf',
    name: 'replace_leaf',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Swap a PROPOSAL for a better version, carrying anything that depends on it across to the replacement. Use this instead of withdrawing and proposing again: a withdrawn leaf is deleted, and anything that named it silently loses the ordering and starts without it.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The proposal being replaced.',
        },
        title: {
          type: 'string',
          description: 'Title for the replacement.',
        },
        body: {
          type: 'string',
          description: 'What doing it involves, and what to avoid repeating.',
        },
        expects: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Repository paths the replacement must leave behind.',
        },
      },
      required: ['id', 'title'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_start_ingest',
    name: 'start_ingest',
    category: 'web',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Crawl a site into this platform\'s corpus, so it can be searched later. Returns immediately with an id — the crawl runs as a background job and the pages are NEVER returned to you. Use this instead of fetch_web_page whenever you want more than a couple of pages, or a document too large to read: there is no size limit here because nothing passes through this conversation.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Where to start crawling.',
        },
        maxDepth: {
          type: 'number',
          description: 'How many links deep to follow from the starting page. 0 fetches only that page, 1 follows its links. Defaults to 1. Depth 3 on a documentation site is usually tens of thousands of pages.',
        },
        maxPages: {
          type: 'number',
          description: 'Hard ceiling on pages fetched. Defaults to 50.',
        },
        domains: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Hosts the crawl may follow links to. Defaults to the starting page\'s own host.',
        },
        keywords: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'What makes a page worth reaching first. A capped crawl spends its budget on pages matching these rather than on whatever happened to be linked earliest.',
        },
      },
      required: ['url'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_ingest_status',
    name: 'ingest_status',
    category: 'web',
    effect: 'read',
    surfaces: ['planning'],
    description: 'Whether a crawl has finished, and what it fetched. Use the id from start_ingest.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The id returned by start_ingest.',
        },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_search_corpus',
    name: 'search_corpus',
    category: 'web',
    effect: 'read',
    surfaces: ['planning'],
    description: 'Find a phrase in everything that has been ingested. Returns short snippets with their source URLs — never whole pages, which is what lets the corpus be far larger than this conversation could hold. Matching is plain text, not a pattern. Anything you put in quotation marks must be copied from a snippet character for character. If you want to restate a snippet in your own words, do it without quotation marks so it reads as your summary rather than as the source.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The phrase to look for.',
        },
        ingestId: {
          type: 'string',
          description: 'Optional — search only one crawl\'s pages.',
        },
      },
      required: ['query'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_personas',
    name: 'list_personas',
    category: 'planning',
    effect: 'read',
    surfaces: ['planning'],
    description: 'List the personas available to assign work to, with what each is for. Call this before assigning personas so the names you use are real ones.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_update_leaf_memory',
    name: 'update_leaf_memory',
    category: 'planning',
    effect: 'write',
    surfaces: ['planning'],
    description: 'Record a persistent memory item (a lesson learned, environment fact, or prompt rule) in the Memory Bank.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'],
          description: 'Memory category.',
        },
        title: {
          type: 'string',
          description: 'Short descriptive title.',
        },
        text: {
          type: 'string',
          description: 'Detailed memory note.',
        },
      },
      required: ['category', 'title', 'text'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_validate_progress',
    name: 'validate_progress',
    category: 'planning',
    surfaces: ['sandbox'],
    description: 'Run the project validation recipe/contract against the current workspace/branch. Executes all required verification checks (build, test, file assertions, content patterns, or runtime probes) and returns detailed diagnostic results. Call this tool during development to confirm your changes before calling finish.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        focusCheck: {
          type: 'string',
          description: 'Optional ID of a specific check to run (runs all checks if omitted).',
        },
      },
    },
    isBuiltIn: true,
  },
];

export const ALL_TOOL_SEEDS: ToolRepositoryItem[] = TOOL_SEEDS;


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
