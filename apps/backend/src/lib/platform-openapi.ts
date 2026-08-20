/**
 * OpenAPI 3.0.3 Specification for the Provisioning Platform API.
 */

export const PLATFORM_OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Provisioning Platform API',
    version: '2.0.0',
    description:
      'API for managing multi-cloud Kubernetes clusters, deployed applications, MCP servers, AI models, and autonomous Harness V2 tasks.',
  },
  servers: [
    {
      url: '/api',
      description: 'Primary API Gateway',
    },
  ],
  paths: {
    '/openapi.json': {
      get: {
        summary: 'Get OpenAPI Specification',
        description: 'Returns the full OpenAPI specification for the platform.',
        responses: {
          '200': {
            description: 'OpenAPI 3.0 specification object',
          },
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Get Current Authenticated User',
        description: 'Returns the currently signed-in user profile, role, and permissions.',
        responses: {
          '200': { description: 'Authenticated user profile' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/clusters': {
      get: {
        summary: 'List Kubernetes Clusters',
        description: 'Returns all provisioned and managed Kubernetes clusters (k3d, AWS, GCP, DO, remote SSH).',
        responses: {
          '200': { description: 'List of clusters' },
        },
      },
      post: {
        summary: 'Provision New Cluster',
        description: 'Initiates a Temporal workflow to provision a new Kubernetes cluster via CDKTF.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  provider: { type: 'string', enum: ['k3d', 'aws', 'gcp', 'do', 'remote'] },
                  region: { type: 'string' },
                },
                required: ['name', 'provider'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Cluster provisioning initiated' },
        },
      },
    },
    '/apps': {
      get: {
        summary: 'List Deployed Applications',
        description: 'Returns all applications deployed across clusters (databases, LLMs, MCP servers, web apps).',
        responses: {
          '200': { description: 'List of deployed applications' },
        },
      },
      post: {
        summary: 'Deploy Application',
        description: 'Deploys an application from the app catalog to a specified cluster.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  clusterId: { type: 'string' },
                  name: { type: 'string' },
                  env: { type: 'object' },
                },
                required: ['type', 'clusterId'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Application deployment initiated' },
        },
      },
    },
    '/models': {
      get: {
        summary: 'List Available LLM Models',
        description: 'Lists all available model providers and endpoints (TabbyAPI, vLLM, Ollama, OpenAI).',
        responses: {
          '200': { description: 'List of models' },
        },
      },
    },
    '/mcp/servers': {
      get: {
        summary: 'List MCP Tool Servers',
        description: 'Returns active MCP servers and the tools they expose.',
        responses: {
          '200': { description: 'List of MCP servers' },
        },
      },
    },
    '/harness-v2/tasks': {
      get: {
        summary: 'List Harness V2 Tasks',
        description: 'Returns all autonomous Harness V2 tasks with turn budgets, Action Gate verdicts, and evaluator scorecards.',
        responses: {
          '200': { description: 'List of Harness V2 tasks' },
        },
      },
      post: {
        summary: 'Create and Launch Harness V2 Task',
        description: 'Creates a task and starts its durable Temporal execution workflow.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  personaId: { type: 'string' },
                  budget: { type: 'object' },
                  rubrics: { type: 'array' },
                },
                required: ['title', 'description', 'personaId'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Harness task created and workflow started' },
        },
      },
    },
    '/harness-v2/tasks/{id}': {
      get: {
        summary: 'Get Harness Task Details',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Task details' },
          '404': { description: 'Task not found' },
        },
      },
    },
    '/harness-v2/tasks/{id}/traces': {
      get: {
        summary: 'Get Turn Traces for Task',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'List of turn execution steps' },
        },
      },
    },
    '/harness-v2/tasks/{id}/pause': {
      post: {
        summary: 'Pause Task Execution',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Task paused' },
        },
      },
    },
    '/harness-v2/tasks/{id}/resume': {
      post: {
        summary: 'Resume Task Execution',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Task resumed' },
        },
      },
    },
    '/harness-v2/conversations': {
      get: {
        summary: 'List Planning Conversations',
        responses: {
          '200': { description: 'List of conversations' },
        },
      },
      post: {
        summary: 'Create New Planning Conversation',
        responses: {
          '201': { description: 'Conversation created' },
        },
      },
    },
    '/harness-v2/conversations/{id}/messages': {
      post: {
        summary: 'Send Message to Orchestrator',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  modelId: { type: 'string' },
                },
                required: ['content'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Assistant message and task proposals' },
        },
      },
    },
    '/harness-v2/conversations/{id}/proposals/{proposalId}/accept': {
      post: {
        summary: 'Accept Proposal and Launch Temporal Workflow',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'proposalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Proposal accepted and task launched' },
        },
      },
    },
  },
};
