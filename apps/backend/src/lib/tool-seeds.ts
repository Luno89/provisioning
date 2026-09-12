import type { ToolEffect } from './action-gate.js';
import { VALIDATION_CHECK_TYPES, K8S_PROBE_KINDS, LOOP_TYPES, TREE_TYPE_PACK_ROLES } from './tree-types.js';
import { WORKFLOW_STAGE_TYPES } from './leaf-workflow-types.js';

export interface ToolRepositoryItem {
  id: string;
  name: string;
  ownerId?: string;
  /**
   * Read or write or propose. The gate gives every row one, and refuses a row without one -- so
   * this is the only property of a row that can stop a granted tool.
   */
  effect?: ToolEffect;
  /**
   * What kind of tool this is, for grouping in the grant list. Nothing at run time reads it.
   *
   * There was a `surfaces` field here too, naming which runtimes were allowed to offer a tool. It
   * is gone: a pack's grant list is edited against the whole catalogue, so a second, invisible list
   * saying where a tool was allowed could only ever disagree with it -- and did, which is how a
   * chat came to be offered `get_leaf` and then answer `No tool named "get_leaf"`. What a tool
   * genuinely cannot run without is a RESOURCE, and it declares that in the registry's `needs`.
   */
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
        brief: {
          type: 'string',
          description: 'What the user actually asked for, in THEIR words, plus the constraints you established together. The planner never sees this conversation, so anything you paraphrase away is lost. Quote them rather than summarising.',
        },
        context: {
          type: 'string',
          description: 'What you already found out: which MCP servers are running, what is deployed, what related projects exist, what you learned from searching. Without this the planner will propose rebuilding things that already exist here.',
        },
        openQuestions: {
          type: 'string',
          description: 'What is still undecided, and what was explicitly ruled OUT. Naming a non-goal is the most useful thing you can hand a planner — it is what stops the plan growing past what was asked for.',
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
    description: 'Check the CI/CD pipeline runs, latest commit SHA, built container image tag, and Kaniko build status for a project. Answers whether an image has been built from the project\'s code.',
    usageGuidance: 'Call this to check if a project\'s code has been built by Kaniko, verify image tags, or inspect build failures before deploying. Do NOT call propose_tree to redeploy — use deploy_project instead.',
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
    id: 'tool_deploy_app',
    name: 'deploy_app',
    category: 'assistant',
    effect: 'write',
    description: 'Deploy an app from the catalogue (built-in like jellyfin or a custom one a user accepted via propose_spec) to a cluster. Check list_infrastructure\'s `deployable` field for valid appType values before calling this. clusterId is optional — omit it and the user\'s only cluster is used automatically; if they have more than one this returns the list instead of deploying, so ask which one and call again with clusterId set.',
    usageGuidance: 'Use this to actually deploy a catalogue app on the user\'s behalf. Not for a project\'s own built image — use deploy_project for that. Only pass clusterId up front if the user already named a cluster or you already called list_clusters this turn.',
    compactGuidance: 'Deploy a catalogue app to a cluster.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        appType: {
          type: 'string',
          description: 'The catalogue id to deploy, e.g. "jellyfin" or a custom spec id like "mongo".',
        },
        clusterId: {
          type: 'string',
          description: 'Which cluster to deploy to. Omit it to use the user\'s only cluster automatically; if they have several, the call fails with the list so you can ask and retry.',
        },
        name: {
          type: 'string',
          description: 'Name for this deployment.',
        },
      },
      required: ['appType', 'name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_clusters',
    name: 'list_clusters',
    category: 'assistant',
    effect: 'read',
    description: 'List the clusters this user can deploy to — id, name, provider and status. Call this when deploy_app reports more than one cluster and you need to ask the user which to use, or whenever you need a clusterId for something other than deploy_app.',
    usageGuidance: 'Usually unnecessary before deploy_app — it already defaults to the user\'s only cluster and reports the list itself when there is more than one. Call this directly only when you need cluster names/status ahead of asking, or outside a deploy_app flow.',
    compactGuidance: 'List the clusters this user can deploy to.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {},
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_project_url',
    name: 'get_project_url',
    category: 'assistant',
    effect: 'read',
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
    id: 'tool_read_project_path',
    name: 'read_project_path',
    category: 'assistant',
    effect: 'read',
    description: 'Read a file\'s content, or list a directory, from a project\'s repository — for exploring a folder the user attached as chat context, or reading a file mentioned in one.',
    usageGuidance: 'Call this when a folder was attached as context and you need to see what is in it, or a conversation references a project file you have not been shown the content of.',
    compactGuidance: 'Read a file or list a folder in a project repository.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative path to a file or folder. Empty string means the repository root.',
        },
      },
      required: ['path'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_get_logs',
    name: 'get_logs',
    category: 'assistant',
    effect: 'read',
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
    description: 'What is running in the cluster that a built service could use — databases, storage, search, embeddings — with the address a pod reaches each one at, and the full list of what this platform can deploy. Call this BEFORE proposing work that depends on a piece of infrastructure. Anything absent from both lists does not exist here and cannot be built: say so rather than planning around it. Never hard-code an address into a leaf — a service a project depends on is provided to it as a binding at deploy time, read from $SERVICE_BINDING_ROOT at runtime.',
    usageGuidance: 'Call before proposing backing services or when checking if a database or platform service is running. Anything not listed does not exist here — say so plainly rather than planning around it.',
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
    id: 'list_tree_types_tool',
    name: 'list_tree_types',
    category: 'assistant',
    effect: 'read',
    description: 'List every project type this platform can build, with what each is for. Call this before calling propose_tree so the type you give is one that actually exists.',
    usageGuidance: 'Call before proposing a project to see what types are available. Every type carries starter files, a validation recipe, and a workspace image.',
    compactGuidance: 'List available project types.',
    requiresBinaries: [],
    parameters: { type: 'object', properties: {} },
    isBuiltIn: true,
  },
  {
    id: 'get_tree_type_tool',
    name: 'get_tree_type',
    category: 'assistant',
    effect: 'read',
    description: 'Full detail of one project type: its overview, starter files, validation recipe (including any groups and loops), bindings, roles and auto-accept settings. Call this before editing a type with any of the set_tree_type_*/add_validation_*/revise_validation_* tools, so you know what already exists.',
    usageGuidance: 'Read the full record of one project type before changing it.',
    compactGuidance: 'Fetch full project type record.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'create_tree_type_tool',
    name: 'create_tree_type',
    category: 'assistant',
    effect: 'write',
    description: 'Create a new project type, or replace your own existing override of one, with just its required overview fields. Add starter files, a validation recipe, bindings, roles, or auto-accept settings afterward with the other set_tree_type_*/add_validation_* tools. Giving the id of a built-in type creates your own override of it — the built-in itself is never changed.',
    usageGuidance: 'Use when asked to define a brand-new kind of project this platform does not already build.',
    compactGuidance: 'Create new project type.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A slug: lowercase letters, numbers and single hyphens, e.g. "cli-tool".' },
        label: { type: 'string', description: 'Short display name, e.g. "CLI tool".' },
        summary: { type: 'string', description: 'One sentence describing what this kind of project is.' },
        doneMeans: { type: 'string', description: 'What acceptance for a leaf of this type starts from — the sentence a judge reads first.' },
        language: { type: 'string', description: 'Which workspace image this type builds in. Call list_tree_types or get_tree_type on an existing type to see valid values (typically node, python, go, or base).' },
        produces: { type: 'string', description: '"service" if this kind of project gets deployed and reached over the network, "artefact" if it is a document or file that is not deployed.' },
      },
      required: ['id', 'label', 'summary', 'doneMeans', 'language', 'produces'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_overview_tool',
    name: 'set_tree_type_overview',
    category: 'assistant',
    effect: 'write',
    description: 'Change the label, summary, doneMeans, language, produces, or requireSources of an existing project type. Omit a field to leave it unchanged.',
    usageGuidance: 'Use to reword or reclassify a project type\'s top-level description.',
    compactGuidance: 'Update project type overview fields.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        label: { type: 'string', description: 'Replacement display name. Omit to leave it alone.' },
        summary: { type: 'string', description: 'Replacement one-sentence summary. Omit to leave it alone.' },
        doneMeans: { type: 'string', description: 'Replacement acceptance starting point. Omit to leave it alone.' },
        language: { type: 'string', description: 'Replacement workspace image id. Omit to leave it alone.' },
        produces: { type: 'string', description: '"service" or "artefact". Omit to leave it alone.' },
        requireSources: { type: 'boolean', description: 'Whether this type\'s output must carry sources. Omit to leave it alone.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_scaffold_file_tool',
    name: 'set_tree_type_scaffold_file',
    category: 'assistant',
    effect: 'write',
    description: 'Add or replace one starter file rendered into a fresh repository when a project of this type is created. {{projectName}} and {{registryHost}} are substituted into both the path and the content. Upserts by path — giving an existing path replaces its content. A type may carry at most 20 starter files.',
    usageGuidance: 'Use to add or edit one scaffold file at a time on a project type.',
    compactGuidance: 'Upsert one project type starter file.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        path: { type: 'string', description: 'Relative repository path, e.g. "src/server.js". Must stay inside the repository.' },
        content: { type: 'string', description: 'File content. May reference {{projectName}} and {{registryHost}}.' },
        executable: { type: 'boolean', description: 'Whether the file should be created with the executable bit set.' },
      },
      required: ['id', 'path', 'content'],
    },
    isBuiltIn: true,
  },
  {
    id: 'delete_tree_type_scaffold_file_tool',
    name: 'delete_tree_type_scaffold_file',
    category: 'assistant',
    effect: 'write',
    description: 'Remove one starter file from a project type by its path.',
    usageGuidance: 'Use to drop a scaffold file that is no longer wanted.',
    compactGuidance: 'Remove one project type starter file.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        path: { type: 'string', description: 'The starter file\'s path, as shown by get_tree_type.' },
      },
      required: ['id', 'path'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_validation_step_tool',
    name: 'add_validation_step',
    category: 'assistant',
    effect: 'write',
    description: 'Add one validation check to a project type\'s recipe — what proves a leaf of this type is actually done. Appended at the end of the top level, or inside a group/loop when parentId names one.',
    usageGuidance: 'Use to add one typed check (file-exists, run-command, http-probe, etc.) to a project type\'s validation recipe.',
    compactGuidance: 'Add one validation check to a project type recipe.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        parentId: { type: 'string', description: 'Optional — the id of a group or loop (from get_tree_type) to add this step inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this step, e.g. "Unit tests pass".' },
        type: { type: 'string', description: `One of: ${VALIDATION_CHECK_TYPES.filter((t) => t !== 'run-command').join(', ')}. Not run-command — this platform does not let a chat assistant author raw shell commands into a recipe; for that, ask a human to add a custom step type in the Tree Types editor, then reference it here with type "custom".` },
        description: { type: 'string', description: 'Optional longer description.' },
        target: { type: 'string', description: 'file-exists/content-matches/git-tracked: a path. http-probe/mcp-probe: a URL. k8s-probe: a resource name.' },
        pattern: { type: 'string', description: 'content-matches only: a regular expression the file must match.' },
        expectedStatus: { type: 'number', description: 'http-probe only: the expected HTTP status code (default 200).' },
        timeoutMs: { type: 'number', description: 'How long this check may take before it counts as failed.' },
        optional: { type: 'boolean', description: 'If true, a failure is reported but does not block the recipe.' },
        runIf: { type: 'string', description: 'Optional — the id of an earlier node in this recipe that must have passed for this step to run.' },
        retries: { type: 'number', description: 'Re-attempt this check up to N times before it counts as failed.' },
        retryDelayMs: { type: 'number', description: 'How long to wait between retries.' },
        kind: { type: 'string', description: `k8s-probe only: one of ${K8S_PROBE_KINDS.join(', ')}.` },
        namespace: { type: 'string', description: 'k8s-probe only: the Kubernetes namespace.' },
        waitForType: { type: 'string', description: 'wait-for only: which other check type to repeatedly attempt (not run-command), using this same step\'s target/pattern/expectedStatus/kind/namespace fields.' },
        pollIntervalMs: { type: 'number', description: 'wait-for only: how often to re-attempt the wrapped condition.' },
        customStepId: { type: 'string', description: 'custom only: the id of an existing custom step definition, as defined by a human in the Tree Types editor\'s "Custom step types" panel.' },
        params: { type: 'object', description: 'custom only: values for the custom step definition\'s declared fields.' },
      },
      required: ['id', 'name', 'type'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_validation_group_tool',
    name: 'add_validation_group',
    category: 'assistant',
    effect: 'write',
    description: 'Add a group to a project type\'s recipe — a purely organizational container for related steps. A group\'s optional/runIf gate all of its children as a unit.',
    usageGuidance: 'Use to organize related validation steps together, or to make a whole set of steps conditional or non-blocking at once.',
    compactGuidance: 'Add a validation group to a project type recipe.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        parentId: { type: 'string', description: 'Optional — the id of another group or loop to nest this group inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this group, e.g. "Deployment checks".' },
        optional: { type: 'boolean', description: 'If true, a failing child is reported but does not block the recipe.' },
        runIf: { type: 'string', description: 'Optional — the id of an earlier node in this recipe that must have passed for this group to run.' },
      },
      required: ['id', 'name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_validation_loop_tool',
    name: 'add_validation_loop',
    category: 'assistant',
    effect: 'write',
    description: 'Add a loop to a project type\'s recipe — repeats a set of steps N times, until they pass, or once per item from a command. Steps run in order, top to bottom, so add the loop\'s children with add_validation_step/add_validation_group using this loop\'s id as parentId.',
    usageGuidance: 'Use for a check that needs repeating: a flaky end-to-end test (until), a fixed stress-test count (count), or one check per file/item a command lists (forEach).',
    compactGuidance: 'Add a validation loop to a project type recipe.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        parentId: { type: 'string', description: 'Optional — the id of a group or another loop to nest this loop inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this loop, e.g. "Retry flaky e2e test".' },
        loopType: { type: 'string', description: `One of: ${LOOP_TYPES.join(', ')}. count runs its steps exactly maxIterations times. until retries (up to maxIterations) until one full pass succeeds. forEach runs itemsCommand once, then runs its steps once per non-blank line of its output, with {{item}} substituted in.` },
        maxIterations: { type: 'number', description: 'count/until only: repeat count (count) or attempt cap (until). Required for those two.' },
        timeoutMs: { type: 'number', description: 'until/forEach only: overall wall-clock budget across every iteration.' },
        itemsCommand: { type: 'string', description: 'forEach only: a shell command whose stdout lines become the items. Required for forEach.' },
        optional: { type: 'boolean', description: 'If true, a failing child is reported but does not block the recipe.' },
        runIf: { type: 'string', description: 'Optional — the id of an earlier node in this recipe that must have passed for this loop to run.' },
      },
      required: ['id', 'name', 'loopType'],
    },
    isBuiltIn: true,
  },
  {
    id: 'revise_validation_step_tool',
    name: 'revise_validation_step',
    category: 'assistant',
    effect: 'write',
    description: 'Change fields on an existing step, group, or loop in a project type\'s recipe. Omit a field to leave it unchanged. Only the fields relevant to that node\'s kind are applied — passing a step-only field like command against a group is silently ignored.',
    usageGuidance: 'Use to edit one existing recipe node in place rather than removing and re-adding it.',
    compactGuidance: 'Edit one recipe node\'s fields.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        stepId: { type: 'string', description: 'The id of the step, group, or loop to change, from get_tree_type.' },
        name: { type: 'string', description: 'Replacement name. Omit to leave it alone.' },
        type: { type: 'string', description: `Step only. One of: ${VALIDATION_CHECK_TYPES.filter((t) => t !== 'run-command').join(', ')}. Not run-command.` },
        description: { type: 'string' },
        target: { type: 'string' },
        pattern: { type: 'string' },
        expectedStatus: { type: 'number' },
        timeoutMs: { type: 'number' },
        optional: { type: 'boolean' },
        runIf: { type: 'string', description: 'The id of an earlier node that must have passed. Pass an empty string to clear it.' },
        retries: { type: 'number' },
        retryDelayMs: { type: 'number' },
        kind: { type: 'string' },
        namespace: { type: 'string' },
        waitForType: { type: 'string' },
        pollIntervalMs: { type: 'number' },
        customStepId: { type: 'string' },
        params: { type: 'object' },
        loopType: { type: 'string', description: `Loop only. One of: ${LOOP_TYPES.join(', ')}.` },
        maxIterations: { type: 'number', description: 'Loop only.' },
        itemsCommand: { type: 'string', description: 'Loop (forEach) only.' },
      },
      required: ['id', 'stepId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'remove_validation_step_tool',
    name: 'remove_validation_step',
    category: 'assistant',
    effect: 'write',
    description: 'Remove one step, group, or loop from a project type\'s recipe, and everything nested inside it if it was a group or loop. Any other node\'s runIf pointing at the removed id is cleared rather than left dangling.',
    usageGuidance: 'Use to delete one recipe node.',
    compactGuidance: 'Remove one recipe node.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        stepId: { type: 'string', description: 'The id of the step, group, or loop to remove, from get_tree_type.' },
      },
      required: ['id', 'stepId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'reorder_validation_steps_tool',
    name: 'reorder_validation_steps',
    category: 'assistant',
    effect: 'write',
    description: 'Replace the order of nodes at one level of a project type\'s recipe — the top level, or inside one group/loop. Give every id currently at that level, in the new order, not just the ones that moved.',
    usageGuidance: 'Use to reorder steps within the same group/loop (or the top level). Moving a node to a DIFFERENT parent is remove_validation_step followed by add_validation_step/add_validation_group/add_validation_loop with the new parentId, not this tool.',
    compactGuidance: 'Reorder recipe nodes at one level.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        parentId: { type: 'string', description: 'Optional — the id of the group or loop whose children to reorder. Omit to reorder the top level.' },
        orderedStepIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every node id currently at that level, in the desired new order.',
        },
      },
      required: ['id', 'orderedStepIds'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_bindings_tool',
    name: 'set_tree_type_bindings',
    category: 'assistant',
    effect: 'write',
    description: 'Replace a project type\'s default service bindings, extra network egress rules, or fixed environment variables. Each field given replaces the current value for that field entirely — give the full list you want kept, not just additions. Omit a field to leave it unchanged.',
    usageGuidance: 'Use to change what a project type\'s leaves can reach on the network, or what env vars every leaf of this type runs with.',
    compactGuidance: 'Replace project type bindings/egress/env.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        defaultBindings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the service bindings every project of this type gets by default (e.g. "gitea"). Replaces the current list.',
        },
        egress: {
          type: 'array',
          items: { type: 'object' },
          description: 'Network reachability beyond what defaultBindings already imply, as a list of {cidr?, namespace?, ports?} rules. Replaces the current list.',
        },
        env: {
          type: 'array',
          items: { type: 'object' },
          description: 'Fixed env vars every leaf of this type runs with, as a list of {name, value} pairs. Replaces the current list.',
        },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_roles_tool',
    name: 'set_tree_type_roles',
    category: 'assistant',
    effect: 'write',
    description: 'Set which pack fills the planner, judge, or merger role for a project type.',
    usageGuidance: 'Use to change which pack plans, reviews, or merges work on a project type.',
    compactGuidance: 'Set a project type\'s planner/judge/merger pack.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        role: { type: 'string', description: `One of: ${TREE_TYPE_PACK_ROLES.join(', ')}.` },
        packSlug: { type: 'string', description: 'The slug of the pack that should fill this role.' },
      },
      required: ['id', 'role', 'packSlug'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_auto_accept_tool',
    name: 'set_tree_type_auto_accept',
    category: 'assistant',
    effect: 'write',
    description: 'Change how readily a proposed leaf on a project of this type auto-accepts without a human clicking accept, and/or the similarity threshold above which two leaves get flagged as possible duplicates. Omit a field to leave it unchanged.',
    usageGuidance: 'Use to make a project type\'s leaves auto-accept more or less readily.',
    compactGuidance: 'Update project type auto-accept policy.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        enabled: { type: 'boolean', description: 'Whether auto-accept is enabled for this type.' },
        requirePersona: { type: 'boolean', description: 'Whether a persona must be assigned before a leaf can auto-accept.' },
        max: { type: 'number', description: 'Maximum leaves auto-accepted per batch.' },
        minTitleChars: { type: 'number', description: 'Minimum title length for a leaf to qualify.' },
        minBodyChars: { type: 'number', description: 'Minimum body length for a leaf to qualify.' },
        duplicateThreshold: { type: 'number', description: 'A number between 0 and 1 — similarity above which two leaves get flagged as possible duplicates.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'set_tree_type_verdict_policy_tool',
    name: 'set_tree_type_verdict_policy',
    category: 'assistant',
    effect: 'write',
    description: 'Change how a single leaf run\'s tests and declared artifacts combine into succeeded or failed for a project of this type. Omit a field to leave it unchanged.',
    usageGuidance: 'Use to make a project type\'s leaves judge their own runs more or less strictly.',
    compactGuidance: 'Update project type verdict policy.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        requireVerify: { type: 'boolean', description: 'If true, a run with no real evidence fails instead of trusting the agent\'s own claim of success.' },
        requireArtifacts: { type: 'boolean', description: 'If true, a leaf that names no artifacts, or whose artifact check could not run, fails rather than passing through unjudged.' },
        combineMode: { type: 'string', enum: ['all', 'any'], description: '"any" (default): either the tests or the artifacts passing is enough. "all": both must independently pass.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'delete_tree_type_tool',
    name: 'delete_tree_type',
    category: 'assistant',
    effect: 'write',
    description: 'Permanently delete your own project type, or your own override of a built-in one (the built-in itself is untouched). Refused while any project still uses this type.',
    usageGuidance: 'Use to remove a project type you created that is no longer wanted.',
    compactGuidance: 'Delete a project type.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
      },
      required: ['id'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_workflow_stage_tool',
    name: 'add_workflow_stage',
    category: 'assistant',
    effect: 'write',
    description: 'Add a stage to a project type\'s leaf workflow — what happens after a leaf finishes (judging it, landing it, resolving merge conflicts, running acceptance checks, replanning). Appended at the end of the top level, or inside a group/loop when parentId names one.',
    usageGuidance: 'Use to add one orchestration stage (judge/land/resolve/accept/replan/release) to a project type\'s leaf workflow.',
    compactGuidance: 'Add one leaf-workflow stage.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence to add to: "onSuccess" (the leaf finished successfully) or "onFailure" (it failed or was cancelled).' },
        parentId: { type: 'string', description: 'Optional — the id of a group or loop (from get_tree_type) to add this stage inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this stage, e.g. "Judge the work".' },
        stage: { type: 'string', description: `Which activity this stage invokes. One of: ${WORKFLOW_STAGE_TYPES.join(', ')}.` },
        optional: { type: 'boolean', description: 'If true, this stage throwing an error is swallowed rather than stopping the rest of the sequence.' },
        runIf: {
          type: 'string',
          description: 'Optional. Either the id of an earlier stage (sugar for "that stage ran without error"), or a condition object: {op: "ranOk"|"threw", ref: <stage id>}, {op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte", path: <dotted path>, value: <literal>}, {op: "exists"|"notExists", path: <dotted path>}, {op: "and"|"or", conditions: [...]}, {op: "not", condition: {...}}. A path starts with "leaf." (e.g. leaf.status), "treeType." (a field on this project type, e.g. treeType.autoAccept.enabled), or "stages.<id>.output." (an earlier stage\'s own result, e.g. stages.land.output.stuck.length).',
        },
        retries: { type: 'number', description: 'Re-attempt this stage\'s activity up to N times before it counts as failed.' },
        retryDelayMs: { type: 'number', description: 'How long to wait between retries.' },
      },
      required: ['id', 'which', 'name', 'stage'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_workflow_group_tool',
    name: 'add_workflow_group',
    category: 'assistant',
    effect: 'write',
    description: 'Add a group to a project type\'s leaf workflow — a purely organizational container for related stages. A group\'s optional/runIf gate all of its children as a unit.',
    usageGuidance: 'Use to organize related workflow stages together, or make a whole set of stages conditional at once.',
    compactGuidance: 'Add a leaf-workflow group.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence to add to: "onSuccess" or "onFailure".' },
        parentId: { type: 'string', description: 'Optional — the id of another group or loop to nest this group inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this group.' },
        optional: { type: 'boolean', description: 'If true, a failing child is reported but does not stop the rest of the sequence.' },
        runIf: { type: 'string', description: 'Optional — a stage id, or a condition object. See add_workflow_stage for the condition shape.' },
      },
      required: ['id', 'which', 'name'],
    },
    isBuiltIn: true,
  },
  {
    id: 'add_workflow_loop_tool',
    name: 'add_workflow_loop',
    category: 'assistant',
    effect: 'write',
    description: 'Add a loop to a project type\'s leaf workflow — repeats a set of stages N times, until they all succeed, or once per item from an earlier stage\'s own output. Add the loop\'s children with add_workflow_stage/add_workflow_group using this loop\'s id as parentId.',
    usageGuidance: 'Use for a sequence that needs repeating: retrying merge-conflict resolution (until), a fixed number of attempts (count), or once per item an earlier stage produced (forEach).',
    compactGuidance: 'Add a leaf-workflow loop.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence to add to: "onSuccess" or "onFailure".' },
        parentId: { type: 'string', description: 'Optional — the id of a group or another loop to nest this loop inside. Omit to add at the top level.' },
        name: { type: 'string', description: 'Short name for this loop.' },
        loopType: { type: 'string', description: `One of: ${LOOP_TYPES.join(', ')}. count runs its stages exactly maxIterations times. until retries (up to maxIterations) until one full pass succeeds. forEach runs its stages once per item from itemsFrom.` },
        maxIterations: { type: 'number', description: 'count/until only: repeat count (count) or attempt cap (until). Required for those two.' },
        timeoutMs: { type: 'number', description: 'Overall wall-clock budget across every iteration.' },
        itemsFrom: { type: 'string', description: 'forEach only: a dotted path into an earlier stage\'s own output that resolves to an array, e.g. "stages.land.output.stuck". Required for forEach. There is no live sandbox during the settle phase, so unlike a validation-recipe loop this cannot run a shell command to list items.' },
        optional: { type: 'boolean', description: 'If true, a failing child is reported but does not stop the rest of the sequence.' },
        runIf: { type: 'string', description: 'Optional — a stage id, or a condition object. See add_workflow_stage for the condition shape.' },
      },
      required: ['id', 'which', 'name', 'loopType'],
    },
    isBuiltIn: true,
  },
  {
    id: 'revise_workflow_stage_tool',
    name: 'revise_workflow_stage',
    category: 'assistant',
    effect: 'write',
    description: 'Change fields on an existing stage, group, or loop in a project type\'s leaf workflow. Omit a field to leave it unchanged. Only the fields relevant to that node\'s kind are applied.',
    usageGuidance: 'Use to edit one existing leaf-workflow node in place rather than removing and re-adding it.',
    compactGuidance: 'Edit one leaf-workflow node\'s fields.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence the node is in: "onSuccess" or "onFailure".' },
        stageId: { type: 'string', description: 'The id of the stage, group, or loop to change, from get_tree_type.' },
        name: { type: 'string', description: 'Replacement name. Omit to leave it alone.' },
        stage: { type: 'string', description: `Stage only. One of: ${WORKFLOW_STAGE_TYPES.join(', ')}.` },
        optional: { type: 'boolean' },
        runIf: { type: 'string', description: 'A stage id, or a condition object. See add_workflow_stage for the shape. Pass an empty string to clear it.' },
        retries: { type: 'number', description: 'Stage only.' },
        retryDelayMs: { type: 'number', description: 'Stage only.' },
        loopType: { type: 'string', description: `Loop only. One of: ${LOOP_TYPES.join(', ')}.` },
        maxIterations: { type: 'number', description: 'Loop only.' },
        timeoutMs: { type: 'number', description: 'Loop only.' },
        itemsFrom: { type: 'string', description: 'Loop (forEach) only.' },
      },
      required: ['id', 'which', 'stageId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'remove_workflow_stage_tool',
    name: 'remove_workflow_stage',
    category: 'assistant',
    effect: 'write',
    description: 'Remove one stage, group, or loop from a project type\'s leaf workflow, and everything nested inside it if it was a group or loop. Any other node\'s runIf referencing the removed id is cleared rather than left dangling.',
    usageGuidance: 'Use to delete one leaf-workflow node.',
    compactGuidance: 'Remove one leaf-workflow node.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence the node is in: "onSuccess" or "onFailure".' },
        stageId: { type: 'string', description: 'The id of the stage, group, or loop to remove, from get_tree_type.' },
      },
      required: ['id', 'which', 'stageId'],
    },
    isBuiltIn: true,
  },
  {
    id: 'reorder_workflow_stages_tool',
    name: 'reorder_workflow_stages',
    category: 'assistant',
    effect: 'write',
    description: 'Replace the order of nodes at one level of a project type\'s leaf workflow — the top level of onSuccess/onFailure, or inside one group/loop. Give every id currently at that level, in the new order, not just the ones that moved.',
    usageGuidance: 'Use to reorder stages within the same group/loop (or the top level). Moving a stage to a DIFFERENT parent is remove_workflow_stage followed by add_workflow_stage/add_workflow_group/add_workflow_loop with the new parentId, not this tool.',
    compactGuidance: 'Reorder leaf-workflow nodes at one level.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tree type id, from list_tree_types.' },
        which: { type: 'string', description: 'Which sequence to reorder: "onSuccess" or "onFailure".' },
        parentId: { type: 'string', description: 'Optional — the id of the group or loop whose children to reorder. Omit to reorder the top level.' },
        orderedStageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every node id currently at that level, in the desired new order.',
        },
      },
      required: ['id', 'which', 'orderedStageIds'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_web_search',
    name: 'web_search',
    category: 'web',
    effect: 'read',
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
    effect: 'read',
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
    effect: 'write',
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
    effect: 'write',
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
    effect: 'write',
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
    effect: 'write',
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
    effect: 'read',
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
    effect: 'write',
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
    effect: 'write',
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
    effect: 'read',
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
    effect: 'write',
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
        treeId: {
          type: 'string',
          description: 'Only leaves belonging to this project. Omit to list every leaf you have, across all of them — each result says which tree and branch it is on.',
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
    description: 'Propose a new piece of work. It is created as a PROPOSAL for a human to accept — calling this does not start any work. Propose one leaf per separately deliverable piece.',
    usageGuidance: 'Propose an atomic, concrete unit of engineering work on the current branch.',
    compactGuidance: 'Propose new leaf on current branch.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        treeId: {
          type: 'string',
          description: 'Which project this belongs to. Required when you are not already working inside one — a chat is not. Get it from list_leaves or list_trees.',
        },
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
    description: 'Change the title, description, assigned persona, or dependencies of a leaf that is still PROPOSED or PENDING (not yet started). Use this when asked to reword something, reassign it, or reorder it against other leaves, instead of proposing a near-duplicate. Once a leaf is running or finished its sandbox already exists and cannot be repointed — delete_leaf and repropose it instead.',
    usageGuidance: 'Refine, reassign, or reorder a proposed or pending task.',
    compactGuidance: 'Update proposed/pending leaf title/body/persona/dependsOn.',
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
        dependsOn: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Replacement list of titles of leaves on this branch that must FINISH before this one starts. Replaces the current list entirely — give every dependency you want kept, not just new ones. Pass an empty array to clear it. Omit this field entirely to leave dependencies unchanged.',
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
    id: 'delete_leaf_tool',
    name: 'delete_leaf',
    category: 'planning',
    effect: 'write',
    description: 'Permanently remove a leaf — proposed, pending, running, failed, or cancelled — and everything nested under it. Cancels it in the workflow engine first if it is running. Refused for a leaf that already SUCCEEDED: that is completed work, and removing it is the human\'s call. Use this to clean up a mistaken or stuck leaf the way withdraw_leaf can only do for pure proposals.',
    usageGuidance: 'Remove a leaf that is no longer wanted, including one already accepted or running. Never removes succeeded work.',
    compactGuidance: 'Delete a leaf and its sub-leaves, cancelling it first if running.',
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
    description: 'Register a project for this user — either a new private Gitea repository (default), or a project scoped to one of their registered local machines. Use it only when the work needs a project that does not exist yet — check list_projects first. Belongs to the user you are talking to; you cannot see or touch anyone else\'s.',
    usageGuidance: 'For a local machine (deviceId set): this checks the target folder for an existing git remote first and reports what it found — do not also pass createRepo unless the user actually wants a new Gitea repo hosted alongside whatever is already there. Without deviceId, behaves as before: creates a Gitea repository in this platform.',
    compactGuidance: 'Register a project — new Gitea repo, or scoped to a local machine.',
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
        deviceId: {
          type: 'string',
          description: 'A registered local execution device id, or its display name exactly as the user gave it (e.g. from "I registered a machine called X"). When set, this project runs on that machine instead of a sandboxed cluster.',
        },
        path: {
          type: 'string',
          description: 'Subfolder under the device\'s root this project lives in. Leave unset for the root itself. Each (device, path) pair can only back one project.',
        },
        createRepo: {
          type: 'boolean',
          description: 'Only relevant with deviceId. Set true to also host a new empty Gitea repository alongside the local machine. Defaults to false — a local-machine project has no repository unless you explicitly ask for one.',
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
    description: 'Declare how we will know this request actually delivered. These checks run in order against the finished, merged result once every leaf is done, and the verdict goes to the user. Set this for any request that produces something — it is the only thing that proves the ASSEMBLED whole works, where per-leaf checks only prove each piece.\nChoose checks that fit what is being built:\n- Software: install dependencies, run the test suite, then RUN the thing the way the user described it — `node src/cli.js "Fall City, WA"`. The run is the important one; a test suite alone will happily pass while the entry point is still a stub.\n- Research or writing: check the deliverable exists and is substantial, and that its claims are traceable — for example that the write-up contains source links.\n- Configuration or infrastructure: check the file parses or validates with whatever tool reads it.\nEach check must exit non-zero when that aspect is broken, or it proves nothing.\nChecks already run from the repository root, so use paths relative to it and do NOT cd anywhere: write `node verify.js`, never `cd /work && node verify.js`.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        treeId: {
          type: 'string',
          description: 'Which project this belongs to. Required when you are not already working inside one — a chat is not. Get it from list_leaves or list_trees.',
        },
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
    id: 'tool_research',
    name: 'research',
    category: 'planning',
    effect: 'read',
    description: 'You have NO web access. Ask for findings on specific questions and they will be researched and returned to you. Break what you need to know into separate, answerable questions — ask only what you genuinely cannot decompose the work without, and use what comes back rather than asking again.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more specific questions. Not topics — questions with answers.',
        },
      },
      required: ['questions'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_write_plan_document',
    name: 'write_plan_document',
    category: 'planning',
    effect: 'write',
    description: 'Commit the plan to the project repository, so every leaf that clones it can read the shape of the whole. Write what no single leaf owns: the architecture, how the pieces fit, and the order they have to happen in. Not a copy of the leaf titles — they are already tracked.',
    usageGuidance: 'Call once, after the leaves are proposed and before you finish. Committing again with the same path replaces nothing — choose a path that does not exist yet if you need a second document.',
    compactGuidance: 'Commit the plan document once, after proposing leaves.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        treeId: {
          type: 'string',
          description: 'Which project this belongs to. Required when you are not already working inside one — a chat is not. Get it from list_leaves or list_trees.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative path, e.g. "PLAN.md". Must stay inside the repository.',
        },
        content: {
          type: 'string',
          description: 'The document, in Markdown.',
        },
      },
      required: ['content'],
    },
    isBuiltIn: true,
  },
  {
    id: 'tool_list_personas',
    name: 'list_personas',
    category: 'planning',
    effect: 'read',
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
    effect: 'read',
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
  deleteTool(id: string): Promise<void>;
}

export async function seedTools(store: ToolSeedStore): Promise<number> {
  const existing = await store.getTools();
  const existingMap = new Map(existing.map((t) => [t.name, t]));
  const shipped = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
  let seededCount = 0;

  for (const seed of ALL_TOOL_SEEDS) {
    const prev = existingMap.get(seed.name);
    if (prev && prev.isBuiltIn === false) continue;
    const next = { ...seed, id: prev?.id ?? seed.id };
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
    await store.saveTool(next);
    seededCount++;
  }

  /**
   * A built-in the seeds no longer ship must go, the way `seedPacks` already retires a pack.
   *
   * This only upserted, so a removed tool lingered in the catalogue for ever: grantable in the UI,
   * offered to a model, and implemented by nothing. `set_leaf_workspace` sat there for months and
   * was still in a live pack's grant list. A row someone made themselves is not ours to delete.
   */
  for (const row of existing) {
    if (row.ownerId != null || row.isBuiltIn === false) continue;
    if (shipped.has(row.name)) continue;
    await store.deleteTool(row.id);
    seededCount++;
  }

  return seededCount;
}
