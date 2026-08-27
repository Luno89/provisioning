import type { ToolEffect } from './action-gate.js';
import { WEB_TOOLS, WEB_TOOL_NAMES } from './leaf-tools.js';
import {
  handleListMcpServers, handleEnableMcpServer, handleAddProjectDependency, handleListInfrastructure,
  handleProposeSpec, handleGetLogs, handleListTrees, handleProposeTree, handleWebSearch,
  handleInspectResources, handleClusterCapacity,
  handleGetProjectPipeline, handleDeployProject, handleGetProjectUrl,
  handleFetchWebPage, handleRequestEscalatedPrivileges, handleGetProjectEnv, handleSetProjectEnv,
  handleRequestSecret, handleInjectSecretToPod, handleGetProjectSecret, handleSetProjectSecret, handleListProjectSecrets,
  type KoalaToolHandler,
} from './koala-tool-handlers.js';

/** The ids a proposal may use, taken from the definitions rather than restated. */

/**
 * The tools Koala gets in general chat.
 *
 * ── WHY NOT LEAF_TOOLS ──
 * Every one of those acts on a branch: propose a leaf, revise it, set its acceptance, attach it to
 * a project. There is no branch here. Offering them would let Koala propose work into a board that
 * does not exist, and the failure would be a tool call returning "no such branch" for reasons the
 * model has no way to understand.
 *
 * What replaces them is one tool: propose a PROJECT. Koala works out what the thing is; the Grove
 * is where it gets built, by personas written for building.
 */

const KOALA_OWN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_mcp_servers',
      description:
        'Detail on the services deployed under your account — what tools each exposes, and whether '
        + 'it is answering. The names alone are already in your prompt; call this when you need to '
        + 'know what a service can DO before deciding whether to hook it up.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Re-check every service rather than using the cached answer.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * The lazy half of the mechanism. Every deployed service's tool schemas riding on every
       * message would cost thousands of tokens per turn for capabilities the conversation is
       * usually not about; a name in the prompt costs ten and is enough to ask for the rest.
       */
      name: 'enable_mcp_server',
      description:
        'Hook up one of the services listed in your prompt, loading its tools so you can call them. '
        + 'They become available IMMEDIATELY — in this same reply — so you can enable a service and '
        + 'then use it without waiting for the user to say anything. Enable one when you need it, '
        + 'not in advance.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The service name, exactly as listed in your prompt.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_tree',
      description:
        'Propose a PROJECT to build. It is created as a proposal for a human to accept — calling '
        + 'this starts nothing and creates nothing. Propose one when the work is clear enough to '
        + 'name and describe; ask a question instead when it is not. One project per separately '
        + 'deliverable thing, not one per step of building it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the project, e.g. "GitHub API MCP".' },
          /**
           * Constrained to the same list the HTTP route validates against, so a model cannot invent
           * a type that then fails on creation with a message about an enum it never saw.
           */
          type: {
            type: 'string',
            /**
             * No enum, and no default.
             *
             * The enum came from a module constant. Project types are owned records now, so a
             * schema built once at import cannot know a type someone added this morning — and a
             * fixed list would quietly exclude it. The handler validates against the caller's own
             * types and refuses with the valid ids, which is the division `validateArgs` sets out:
             * this declares the shape, the handler decides whether the call makes sense.
             *
             * Omitting it is refused rather than defaulted. The type decides the image, the
             * skeleton and what finishing means; substituting one silently builds a different kind
             * of project than was asked for.
             */
            description: 'What kind of thing this is. Call list_tree_types to see the ids available.',
          },
          goal: {
            type: 'string',
            description:
              'What done looks like, in a sentence or two. This is what the planner reads when the '
              + 'project is opened, so write what someone would need to know without this conversation.',
          },
        },
        required: ['name', 'goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * Koala could SEE infrastructure and not wire it up: asked to make a service cache in mongo it
       * would discover the database, propose a project, and stop — a plausible answer from something
       * that quietly cannot act. A person should not have to know which surface is able to do a
       * thing.
       */
      name: 'add_project_dependency',
      description:
        'Declare that an existing project depends on a running service, so its deployment is given '
        + 'the address and credentials for it. Use the projectId reported by list_mcp_servers or '
        + 'list_trees. The service must be one list_infrastructure reports. Nothing is deployed by '
        + 'this — the binding is provided the next time that project deploys.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project that needs it.' },
          service: { type: 'string', description: 'The running service to depend on, by name.' },
          as: {
            type: 'string',
            description:
              'Optional directory name under $SERVICE_BINDING_ROOT. Defaults to the service type; '
              + 'give one only when a project needs two of the same kind.',
          },
        },
        required: ['projectId', 'service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * Added after Koala planned MongoDB caching for a platform with no MongoDB. `mongo` is not in
       * APP_TYPES, so one cannot be deployed, and the instance's own runs under docker-compose —
       * not in the cluster and not reachable by a built service. Koala had no way to know, so it
       * agreed. A request the platform cannot satisfy should be refused in conversation, where it
       * costs a sentence, not in a build, where it costs a run.
       */
      name: 'list_infrastructure',
      description:
        'What is running in the cluster that a built service could use — databases, storage, search, '
        + 'embeddings — and the full list of what this platform can deploy. Call this BEFORE '
        + 'proposing work that depends on a piece of infrastructure. Anything absent from both lists '
        + 'does not exist here and cannot be built: say so rather than planning around it.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * Adding a deployable app is a RECORD now, not a construct — see lib/app-spec.ts. This is how
       * Koala writes one. Proposed and accepted like everything else it creates: a spec runs
       * containers in someone's cluster, and the moment before it exists is the cheapest place to
       * look at it.
       */
      name: 'propose_spec',
      description:
        'Propose a new deployable app type, so this platform can deploy something it currently '
        + 'cannot — a database, a cache, a queue. It is created as a PROPOSAL for a human to accept; '
        + 'nothing is deployed and nothing is added to the catalogue by calling this. Check '
        + 'list_infrastructure first: if it is already deployable, propose nothing.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Lowercase name, e.g. "mongo". Becomes the namespace, Service name and DNS label.',
          },
          image: { type: 'string', description: 'Container image with a tag, e.g. "mongo:7".' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional container arguments.' },
          ports: {
            type: 'array',
            description: 'At least one. Services target ports by name, so each needs one.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, port: { type: 'number' } },
              required: ['name', 'port'],
            },
          },
          env: {
            type: 'array',
            description:
              'Environment variables. For a credential use `generate` with `fromSecret` and give NO '
              + 'value — the platform mints it and injects it from a Secret, and you never see it. '
              + 'Never write a password here.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                fromSecret: { type: 'string', description: 'Secret key a generated value is read from.' },
                generate: { type: 'string', enum: ['password', 'username'] },
              },
              required: ['name'],
            },
          },
          volumes: {
            type: 'array',
            description: 'Persistent disks. Anything that stores data needs one, or it is lost on restart.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, size: { type: 'string' } },
              required: ['path', 'size'],
            },
          },
          resources: {
            type: 'object',
            description:
              'REQUIRED. Both limits must be given — an app with no memory limit can take a node '
              + 'down and evict everything on it.',
            properties: {
              limits: {
                type: 'object',
                properties: { cpu: { type: 'string' }, memory: { type: 'string' } },
                required: ['cpu', 'memory'],
              },
              requests: {
                type: 'object',
                properties: { cpu: { type: 'string' }, memory: { type: 'string' } },
              },
            },
            required: ['limits'],
          },
          liveness: {
            type: 'object',
            description: 'An HTTP health check, when the app has one. Omit for anything that does not speak HTTP.',
            properties: { path: { type: 'string' }, port: { type: 'number' } },
            required: ['path', 'port'],
          },
          ingressPort: {
            type: 'number',
            description: 'Only if a person would open this in a browser. Omit for databases and caches.',
          },
        },
        required: ['id', 'image', 'ports', 'resources'],
      },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * Added after Koala guessed. It found a crash-looping MongoDB and said the cause was
       * "insufficient memory or a missing persistent volume" — plausible and wrong. The real reason
       * was in the pod's own output, which nothing let it read.
       */
      name: 'get_logs',
      description:
        'The recent output of a deployment, for working out WHY it is not working. Read this before '
        + 'saying what is wrong with something in `broken` — the cause is almost always in the last '
        + 'few lines, and guessing from the app name sends the fix in the wrong direction.',
      parameters: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'The deployment name, as reported by list_infrastructure.' },
        },
        required: ['deployment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_events',
      description:
        'Recent Kubernetes events for a deployment. Answers the failures logs cannot: an image that '
        + 'will not pull, a volume that never bound, a pod that was never scheduled. Use it when '
        + 'get_logs is empty — a container that never started has no output.',
      parameters: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'The deployment name, as reported by list_infrastructure.' },
        },
        required: ['deployment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      /**
       * The general read, added because two specific ones were not enough.
       *
       * `get_logs` and `get_events` answer one question each. Everything else a person asks — why is
       * this pod pending, what did the PVC bind to, which container is restarting — had no tool, so
       * the model went back to reasoning from an app's name. That is precisely the failure
       * `kube-diagnostics.ts` was written to stop, reappearing one question over.
       */
      name: 'inspect_resources',
      description:
        'Read the live state of Kubernetes objects belonging to one of your deployments or leaf '
        + 'sandboxes — `get` for a list, `describe` for the detail including events and why a pod is '
        + 'pending. Use it when get_logs is empty or the cause is not in the output: a pod that never '
        + 'scheduled, a volume that never bound, a container stuck pulling. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          verb: { type: 'string', description: 'get or describe.', enum: ['get', 'describe'] },
          resource: {
            type: 'string',
            description: 'pods, deployments, services, pvc, events, replicasets, jobs, ingress, nodes.',
          },
          target: {
            type: 'string',
            description: 'The deployment name from list_infrastructure, or a leaf id to look at its '
              + 'sandbox. Not needed for cluster-wide resources like nodes.',
          },
          name: { type: 'string', description: 'One specific object, optional.' },
        },
        required: ['verb', 'resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cluster_capacity',
      description:
        'What the cluster has left: node CPU and memory usage, and node conditions such as disk or '
        + 'memory pressure. The question behind "why is everything slow" and "why will nothing '
        + 'schedule" — both of which look like application bugs from inside a single deployment.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Optional deployment or leaf sandbox, to see its pods\' usage instead of nodes.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_trees',
      description:
        'The projects that already exist, with how their work is going. Call this before proposing '
        + 'anything, so you extend what is there instead of proposing a second copy of it — and to '
        + 'answer questions about how something is coming along.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_pipeline',
      description:
        'Check the CI/CD pipeline runs, latest commit SHA, built container image tag, and Kaniko '
        + 'build status for a project. Answers whether an image has been built from the project\'s code.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to inspect.' },
          name: { type: 'string', description: 'Project name to inspect, if ID is not known.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_project',
      description:
        'Promote and deploy a project\'s built container image to its target Kubernetes cluster. '
        + 'Use this when the project has built successfully and needs to be deployed as a running service.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to deploy.' },
          name: { type: 'string', description: 'Project name to deploy, if ID is not known.' },
          runId: { type: 'string', description: 'Specific pipeline run ID to promote, if not latest.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_url',
      description:
        'Get the live reachable URL, listening port, cluster namespace, and health status for a '
        + 'deployed project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID.' },
          name: { type: 'string', description: 'Project name.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_escalated_privileges',
      description:
        'Request elevated access to cluster-wide system namespaces (monitoring, gitea, kube-system) or administrator '
        + 'privileges when diagnosing platform infrastructure. State a clear, honest reason.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Clear explanation of why elevated access is required.' },
          scope: { type: 'string', description: 'Requested privilege scope.', enum: ['cluster-read', 'cluster-admin'] },
          namespaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific system namespaces requested (e.g. ["monitoring", "gitea"]).',
          },
        },
        required: ['reason', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_env',
      description:
        'View the currently configured runtime environment variables (deployEnv) for an existing project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to inspect.' },
          name: { type: 'string', description: 'Project name to inspect, if ID is not known.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_project_env',
      description:
        'Set or update runtime environment variables (e.g. GITEA_URL, GITEA_TOKEN, API keys) on an existing project.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_secret',
      description:
        'Request a sensitive credential, token, or API key from the user via a secure interactive UI card. '
        + 'The secret is encrypted and vaulted directly in Infisical without appearing in chat logs.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'inject_secret_to_pod',
      description:
        'Inject a vaulted secret into a deployed project pod via Kubernetes Secret (<app>-secrets) as an environment variable or file, and trigger a rolling restart.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_secret',
      description: 'Retrieve metadata and vault reference for a project secret in Infisical.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID.' },
          key: { type: 'string', description: 'Secret key name.' },
        },
        required: ['projectId', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_project_secret',
      description: 'Set or update a secret in a project\'s Infisical vault.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_project_secrets',
      description: 'List configured secret keys in Infisical for a project with masked previews (never raw plaintext).',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID.' },
        },
        required: ['projectId'],
      },
    },
  },
] as const;

/**
 * The web tools, taken from LEAF_TOOLS rather than restated.
 *
 * They were implemented in the runner and wired into the chat route's context, and never offered to
 * a model, because nobody added a schema here — so Koala has not been able to search the web at
 * all. Importing the declarations means there is exactly one copy of them in the codebase, which is
 * the same rule the header of this file states about TREE_TYPES.
 */
export const KOALA_TOOLS = [...KOALA_OWN_TOOLS, ...WEB_TOOLS] as const;

/** Every tool Koala can be offered, by name. Derived, so it cannot list one that does not exist. */
export type KoalaToolName = typeof KOALA_OWN_TOOLS[number]['function']['name'] | typeof WEB_TOOL_NAMES[number];

/**
 * Schema ↔ handler, joined so that neither can exist alone.
 */
export const KOALA_TOOL_HANDLERS = {
  list_mcp_servers: handleListMcpServers,
  enable_mcp_server: handleEnableMcpServer,
  add_project_dependency: handleAddProjectDependency,
  list_infrastructure: handleListInfrastructure,
  propose_spec: handleProposeSpec,
  // Both names share one implementation, which reads the name to decide which command to build.
  get_logs: (ctx, args) => handleGetLogs(ctx, args, 'get_logs'),
  get_events: (ctx, args) => handleGetLogs(ctx, args, 'get_events'),
  inspect_resources: handleInspectResources,
  cluster_capacity: handleClusterCapacity,
  list_trees: handleListTrees,
  propose_tree: handleProposeTree,
  get_project_pipeline: handleGetProjectPipeline,
  deploy_project: handleDeployProject,
  get_project_url: handleGetProjectUrl,
  request_escalated_privileges: handleRequestEscalatedPrivileges,
  get_project_env: handleGetProjectEnv,
  set_project_env: handleSetProjectEnv,
  request_secret: handleRequestSecret,
  inject_secret_to_pod: handleInjectSecretToPod,
  get_project_secret: handleGetProjectSecret,
  set_project_secret: handleSetProjectSecret,
  list_project_secrets: handleListProjectSecrets,
  web_search: handleWebSearch,
  fetch_web_page: handleFetchWebPage,
} satisfies Record<KoalaToolName, KoalaToolHandler>;

/**
 * What each tool DOES, for the Action Gate.
 */
export const KOALA_TOOL_EFFECTS = {
  list_mcp_servers: 'read',
  enable_mcp_server: 'write',
  add_project_dependency: 'write',
  list_infrastructure: 'read',
  propose_spec: 'propose',
  get_logs: 'read',
  get_events: 'read',
  inspect_resources: 'read',
  cluster_capacity: 'read',
  list_trees: 'read',
  propose_tree: 'propose',
  get_project_pipeline: 'read',
  deploy_project: 'write',
  get_project_url: 'read',
  request_escalated_privileges: 'propose',
  get_project_env: 'read',
  set_project_env: 'write',
  request_secret: 'propose',
  inject_secret_to_pod: 'write',
  get_project_secret: 'read',
  set_project_secret: 'write',
  list_project_secrets: 'read',
  web_search: 'read',
  fetch_web_page: 'read',
} satisfies Record<KoalaToolName, ToolEffect>;
