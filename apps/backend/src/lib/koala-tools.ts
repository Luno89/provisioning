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
  'list_mcp_servers', 'enable_mcp_server', 'propose_tree', 'list_trees', 'list_infrastructure',
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
      name: 'list_trees',
      description:
        'The projects that already exist, with how their work is going. Call this before proposing '
        + 'anything, so you extend what is there instead of proposing a second copy of it — and to '
        + 'answer questions about how something is coming along.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;
