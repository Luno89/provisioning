import { TREE_TYPES } from './trees.js';

/** The ids a proposal may use, taken from the definitions rather than restated. */
const TREE_TYPE_IDS = TREE_TYPES.map((t) => t.id);

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

export const KOALA_TOOL_NAMES = [
  'list_mcp_servers', 'enable_mcp_server', 'propose_tree', 'propose_spec', 'list_trees',
  'list_infrastructure', 'add_project_dependency', 'get_logs', 'get_events',
  'web_search', 'fetch_web_page',
] as const;

export const KOALA_TOOLS = [
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
            // Enumerated from the same source the route validates against, so the model cannot pick
            // a type that is then silently replaced.
            enum: TREE_TYPE_IDS,
            description: 'What kind of thing this is. Omit it if none fits and one will be chosen.',
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
      name: 'list_trees',
      description:
        'The projects that already exist, with how their work is going. Call this before proposing '
        + 'anything, so you extend what is there instead of proposing a second copy of it — and to '
        + 'answer questions about how something is coming along.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;
