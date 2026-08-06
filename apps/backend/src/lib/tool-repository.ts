import { WORKSPACE_IMAGES, type WorkspaceLanguage } from './workspace-spec.js';

export interface ToolRepositoryItem {
  id: string;
  name: string;
  category: 'sandbox' | 'planning' | 'database' | 'git' | 'http' | 'linter' | 'custom';
  description: string;
  requiresBinaries: string[];
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  scriptCommand?: string;
  isBuiltIn?: boolean;
}

export const TOOL_REPOSITORY: ToolRepositoryItem[] = [
  // ── SANDBOX EXECUTION TOOLS ──
  {
    id: 'read_file_tool',
    name: 'read_file',
    category: 'sandbox',
    description: 'Read the text content of a file from the sandbox filesystem (/work).',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from /work, e.g. "src/index.js".' },
      },
      required: ['path'],
    },
  },
  {
    id: 'write_file_tool',
    name: 'write_file',
    category: 'sandbox',
    description: 'Create or overwrite a file in the sandbox filesystem with text content.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from /work, e.g. "auth.js".' },
        content: { type: 'string', description: 'The text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    id: 'run_command_tool',
    name: 'run_command',
    category: 'sandbox',
    description: 'Execute a bash shell command inside the sandbox container.',
    requiresBinaries: ['bash'],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string, e.g. "node test.js".' },
      },
      required: ['command'],
    },
  },
  {
    id: 'finish_tool',
    name: 'finish',
    category: 'sandbox',
    description: 'Signal that the task is complete and end the agent execution turn.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line summary of what was accomplished.' },
      },
    },
  },

  // ── CORE PLANNING TOOLS ──
  {
    id: 'list_leaves_tool',
    name: 'list_leaves',
    category: 'planning',
    description: 'List work items (leaves) already tracked on this branch to avoid duplicating work.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by leaf status.', enum: ['proposed', 'pending', 'running', 'succeeded', 'failed', 'cancelled'] },
      },
    },
  },
  {
    id: 'get_leaf_tool',
    name: 'get_leaf',
    category: 'planning',
    description: 'Fetch full detail of a leaf: description, sub-items, and failed attempt error logs.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
      },
      required: ['id'],
    },
  },
  {
    id: 'propose_leaf_tool',
    name: 'propose_leaf',
    category: 'planning',
    description: 'Propose a new piece of work as a PROPOSAL for a human to accept.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title.' },
        body: { type: 'string', description: 'What doing this involves.' },
        parentLeafId: { type: 'string', description: 'Optional parent leaf id.' },
        language: { type: 'string', description: 'Toolchain language.', enum: ['node', 'python', 'go', 'base'] },
      },
      required: ['title'],
    },
  },
  {
    id: 'revise_leaf_tool',
    name: 'revise_leaf',
    category: 'planning',
    description: 'Change the title or description of a proposed leaf.',
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
  },
  {
    id: 'withdraw_leaf_tool',
    name: 'withdraw_leaf',
    category: 'planning',
    description: 'Withdraw a leaf proposal that is no longer needed.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        reason: { type: 'string', description: 'Reason for withdrawal.' },
      },
      required: ['id'],
    },
  },
  {
    id: 'set_leaf_workspace_tool',
    name: 'set_leaf_workspace',
    category: 'planning',
    description: 'Change which toolchain a leaf runs in (node, python, go, base).',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        language: { type: 'string', description: 'Toolchain language.', enum: ['node', 'python', 'go', 'base'] },
      },
      required: ['id', 'language'],
    },
  },
  {
    id: 'list_projects_tool',
    name: 'list_projects',
    category: 'planning',
    description: 'List registered git repositories for the current user.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    id: 'create_project_tool',
    name: 'create_project',
    category: 'planning',
    description: 'Create a new private git repository for the user.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short repository name.' },
        description: { type: 'string', description: 'One-line description.' },
      },
      required: ['name'],
    },
  },
  {
    id: 'set_leaf_project_tool',
    name: 'set_leaf_project',
    category: 'planning',
    description: 'Attach a leaf to a git repository project.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The leaf id.' },
        projectId: { type: 'string', description: 'The project id.' },
      },
      required: ['id', 'projectId'],
    },
  },

  // ── SPECIALIZED EXECUTION TOOLS ──
  {
    id: 'test_runner_tool',
    name: 'run_tests',
    category: 'sandbox',
    description: 'Execute unit tests (Vitest/Jest/Pytest/Go test) in the sandbox and return failing assertions and stack traces.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional file pattern filter, e.g. "auth.test.js".' },
      },
    },
  },
  {
    id: 'git_diff_inspector',
    name: 'inspect_git_diff',
    category: 'git',
    description: 'Inspect current uncommitted diffs and staged changes against the base branch in the sandbox.',
    requiresBinaries: ['git'],
    parameters: {
      type: 'object',
      properties: {
        stagedOnly: { type: 'boolean', description: 'Set true to inspect only staged changes.' },
      },
    },
  },
  {
    id: 'http_request_tester',
    name: 'test_http_endpoint',
    category: 'http',
    description: 'Execute an HTTP request against a local running service port inside the sandbox to verify API responses.',
    requiresBinaries: ['curl'],
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method, e.g. GET, POST, PUT, DELETE.', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'URL path, e.g. "/api/items" or "/health".' },
        port: { type: 'number', description: 'Port number, e.g. 3000.' },
        body: { type: 'string', description: 'Optional JSON payload for POST/PUT requests.' },
      },
      required: ['method', 'path'],
    },
  },
  {
    id: 'linter_audit_tool',
    name: 'run_linter_audit',
    category: 'linter',
    description: 'Run static code analysis or linter check on sandbox files and return structured warnings.',
    requiresBinaries: ['node', 'npm'],
    parameters: {
      type: 'object',
      properties: {
        targetDir: { type: 'string', description: 'Directory path relative to /work, e.g. "src".' },
      },
    },
  },
  {
    id: 'db_query_tool',
    name: 'query_in_memory_db',
    category: 'database',
    description: 'Execute a read/write query against an in-memory test database instance in the sandbox.',
    requiresBinaries: ['node'],
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection or table name.' },
        query: { type: 'string', description: 'JSON query payload string.' },
      },
      required: ['collection', 'query'],
    },
  },
  {
    id: 'save_harness_memory_tool',
    name: 'save_harness_memory',
    category: 'sandbox',
    description: 'Record a persistent lesson learned, environment fact, or prompt guidance rule into the Memory Bank for review/use.',
    requiresBinaries: [],
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'], description: 'Memory category.' },
        title: { type: 'string', description: 'Short descriptive title.' },
        text: { type: 'string', description: 'Detailed insight, rule, or fact.' },
        suggestedScope: { type: 'string', enum: ['project', 'global'], description: 'Suggested scope (project or global).' },
      },
      required: ['category', 'title', 'text'],
    },
  },
];

export function getToolRepository(category?: string): ToolRepositoryItem[] {
  if (!category) return TOOL_REPOSITORY;
  return TOOL_REPOSITORY.filter((t) => t.category === category);
}

export function findToolById(id: string): ToolRepositoryItem | undefined {
  return TOOL_REPOSITORY.find((t) => t.id === id || t.name === id);
}

export function validateImageForTools(language: WorkspaceLanguage, toolIds: string[]): { valid: boolean; missingBinaries: string[] } {
  const spec = WORKSPACE_IMAGES[language];
  if (!spec) return { valid: false, missingBinaries: ['unknown_language'] };
  
  const required = new Set<string>();
  for (const id of toolIds) {
    const item = findToolById(id);
    if (item) {
      item.requiresBinaries.forEach((b) => required.add(b));
    }
  }
  
  const missing = Array.from(required).filter((b) => spec.absent.includes(b));
  return { valid: missing.length === 0, missingBinaries: missing };
}

export function formatToolRepoForOpenAI(items: ToolRepositoryItem[] = TOOL_REPOSITORY) {
  return items.map((item) => ({
    type: 'function',
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  }));
}
