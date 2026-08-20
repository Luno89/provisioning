/**
 * Orchestrator Tools Definition for Harness V2.
 *
 * Equips the Harness V2 Orchestrator with web search, web page extraction,
 * infrastructure inspection, log diagnostics, file reading, semantic memory search, and task proposals.
 */

export const HARNESS_ORCHESTRATOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for documentation, libraries, GitHub repositories, or error solutions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_web_page',
      description: 'Fetch and extract the readable text/markdown from a web URL using Crawl4AI or HTTP fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_infrastructure',
      description: 'List all running clusters, deployed applications (LLMs, databases, search, vector stores), and catalog status.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_logs',
      description: 'Get the recent stdout/stderr logs of a running deployment in Kubernetes for diagnostics.',
      parameters: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'Name of the deployment (e.g. tabbyapi-production, traefik).' },
        },
        required: ['deployment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_events',
      description: 'Get Kubernetes events for a deployment or pod to diagnose scheduling, crash, or image pull issues.',
      parameters: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'Name of the deployment to inspect.' },
        },
        required: ['deployment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_workspace_file',
      description: 'Read the contents of a source code or configuration file in the project repository.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file from repo root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_semantic_memory',
      description: 'Search the semantic vector memory bank for relevant project facts, architecture decisions, and notes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_task',
      description: 'Propose a structured, durable Harness V2 task with persona assignment, dynamic budget, and weighted evaluation rubrics.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Clear, imperative task title.' },
          description: { type: 'string', description: 'Detailed scope, acceptance criteria, and expected deliverables.' },
          personaId: { type: 'string', enum: ['coder', 'researcher', 'architect', 'evaluator'], default: 'coder' },
          maxTurns: { type: 'number', description: 'Optional turn limit (default estimated from scope complexity).' },
          rubrics: {
            type: 'array',
            description: 'Optional custom scoring criteria for the independent evaluator.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                weight: { type: 'number' },
                description: { type: 'string' },
              },
              required: ['name', 'weight', 'description'],
            },
          },
        },
        required: ['title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List existing Harness V2 tasks, their statuses, turn progress, and evaluator scores.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
] as const;
