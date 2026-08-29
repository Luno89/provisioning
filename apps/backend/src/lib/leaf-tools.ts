import type { ToolEffect } from './action-gate.js';
import { WORKSPACE_IMAGES, DEFAULT_WORKSPACE_LANGUAGE } from './workspace-spec.js';
import type { Leaf } from './leaves.js';

export const MAX_TOOL_ROUNDS = 8;

export const WEB_TOOL_NAMES = ['web_search', 'fetch_web_page'] as const;

export const LEAF_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_leaves',
      description:
        'List the work items (leaves) already tracked on this branch. Call this before proposing ' +
        'anything, to avoid duplicating work that exists.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_leaf',
      description:
        'Full detail of one leaf: its description, its sub-items, and every failed attempt with ' +
        'the error. Use this when asked why something failed or what a leaf involves.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_leaf',
      description:
        'Propose a new piece of work. It is created as a PROPOSAL for a human to accept — calling ' +
        'this does not start any work. Propose one leaf per separately deliverable piece.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, e.g. "Add a rate limit to /api/chat".' },
          body: { type: 'string', description: 'What doing this involves, in one or two sentences.' },
          parentLeafId: { type: 'string', description: 'Optional — the leaf this is a sub-item of.' },
          expects: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional — repository paths this work must leave behind, e.g. ["NOTES.md"] or '
              + '["src/client.js","test/client.test.js"]. Checked after the leaf runs: each must be '
              + 'committed and non-empty, or the leaf is marked failed. Give these for work that has '
              + 'no tests to run (research, documentation, configuration) — without them nothing can '
              + 'check that the work was actually produced. '
              + 'Use the file extension and directory layout this project actually uses — they are '
              + 'stated above. Do not guess .ts for a JavaScript project.',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional — titles of leaves on this branch that must FINISH before this one starts. '
              + 'Use it whenever this work builds on another leaf\'s output: without it every leaf '
              + 'starts at the same time in its own empty sandbox, and later steps find nothing to '
              + 'build on. Give the titles exactly as you proposed them. The result confirms which '
              + 'ones were recorded and warns about any that matched no leaf — check it, because an '
              + 'unmatched title means this leaf will not wait after all.',
          },
          projectId: {
            type: 'string',
            description:
              'Optional — the id of an existing project this work belongs in, from list_projects or '
              + 'the projectId reported by list_mcp_servers. Give it whenever the work CHANGES '
              + 'something that already exists: the leaf then checks out that repository, and '
              + 'merging rebuilds and redeploys it. Omit it for genuinely new work, which gets a '
              + 'repository of its own.',
          },
          mcp: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional — names of MCP servers this leaf must CALL while it runs, from '
              + 'list_mcp_servers. Give these whenever the work uses a deployed service: without '
              + 'them the leaf has no tools for it and can only guess at HTTP. A server built '
              + 'earlier in this same plan can be named here by the leaf that verifies it.',
          },
          persona: {
            type: 'string',
            description:
              'REQUIRED — the name of the persona that will do this work, exactly as listed by '
              + 'list_personas. A persona decides the toolchain, what the work may reach on the '
              + 'network, which tools it can call, how long it gets and where its output goes. '
              + 'There is no default: a leaf with none assigned cannot run, and you will be asked '
              + 'again until one is set.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_acceptance',
      description:
        'Declare how we will know this request actually delivered. These checks run in order '
        + 'against the finished, merged result once every leaf is done, and the verdict goes to the '
        + 'user. Set this for any request that produces something — it is the only thing that '
        + 'proves the ASSEMBLED whole works, where per-leaf checks only prove each piece.\n'
        + 'Choose checks that fit what is being built:\n'
        + '- Software: install dependencies, run the test suite, then RUN the thing the way the user '
        + 'described it — `node src/cli.js "Fall City, WA"`. The run is the important one; a test '
        + 'suite alone will happily pass while the entry point is still a stub.\n'
        + '- Research or writing: check the deliverable exists and is substantial, and that its '
        + 'claims are traceable — for example that the write-up contains source links.\n'
        + '- Configuration or infrastructure: check the file parses or validates with whatever tool '
        + 'reads it.\n'
        + 'Each check must exit non-zero when that aspect is broken, or it proves nothing.\n'
        + 'Checks already run from the repository root, so use paths relative to it and do NOT '
        + 'cd anywhere: write `node verify.js`, never `cd /work && node verify.js`.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'revise_leaf',
      description:
        'Change the title, description, or assigned persona of a leaf that is still a PROPOSAL. ' +
        'Use this when asked to reword something already proposed, or to say who should do it, ' +
        'instead of proposing a near-duplicate. Accepted or running work cannot be edited.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' },
          title: { type: 'string', description: 'Replacement title. Omit to leave it alone.' },
          body: { type: 'string', description: 'Replacement description. Omit to leave it alone.' },
          persona: {
            type: 'string',
            description:
              'The name of the persona that should do this work, exactly as listed. A persona '
              + 'decides the toolchain, what the work may reach on the network, which tools it can '
              + 'call and how long it gets — work with none assigned cannot run.',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_leaf',
      description:
        'Swap a PROPOSAL for a better version, carrying anything that depends on it across to the '
        + 'replacement. Use this instead of withdrawing and proposing again: a withdrawn leaf is '
        + 'deleted, and anything that named it silently loses the ordering and starts without it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The proposal being replaced.' },
          title: { type: 'string', description: 'Title for the replacement.' },
          body: { type: 'string', description: 'What doing it involves, and what to avoid repeating.' },
          expects: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repository paths the replacement must leave behind.',
          },
        },
        required: ['id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'withdraw_leaf',
      description:
        'Withdraw a PROPOSAL you no longer stand behind — a duplicate, or something the user ruled ' +
        "out. Only works while it is still a proposal; accepted work is the human's to cancel.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' },
          reason: { type: 'string', description: 'Why, in a few words. Shown to the user.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_ingest',
      description:
        'Crawl a site into this platform\'s corpus, so it can be searched later. Returns immediately '
        + 'with an id — the crawl runs as a background job and the pages are NEVER returned to you. '
        + 'Use this instead of fetch_web_page whenever you want more than a couple of pages, or a '
        + 'document too large to read: there is no size limit here because nothing passes through '
        + 'this conversation.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Where to start crawling.' },
          maxDepth: {
            type: 'number',
            description:
              'How many links deep to follow from the starting page. 0 fetches only that page, 1 '
              + 'follows its links. Defaults to 1. Depth 3 on a documentation site is usually tens '
              + 'of thousands of pages.',
          },
          maxPages: { type: 'number', description: 'Hard ceiling on pages fetched. Defaults to 50.' },
          domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Hosts the crawl may follow links to. Defaults to the starting page\'s own host.',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description:
              'What makes a page worth reaching first. A capped crawl spends its budget on pages '
              + 'matching these rather than on whatever happened to be linked earliest.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ingest_status',
      description: 'Whether a crawl has finished, and what it fetched. Use the id from start_ingest.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id returned by start_ingest.' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_corpus',
      description:
        'Find a phrase in everything that has been ingested. Returns short snippets with their '
        + 'source URLs — never whole pages, which is what lets the corpus be far larger than this '
        + 'conversation could hold. Matching is plain text, not a pattern. '
        + 'Anything you put in quotation marks must be copied from a snippet character for '
        + 'character. If you want to restate a snippet in your own words, do it without quotation '
        + 'marks so it reads as your summary rather than as the source.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The phrase to look for.' },
          ingestId: { type: 'string', description: 'Optional — search only one crawl\'s pages.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_personas',
      description:
        'List the personas available to assign work to, with what each is for. Call this before '
        + 'assigning personas so the names you use are real ones.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description:
        'List the git repositories this user has registered. Call this before creating one, and ' +
        'before attaching work to a project, so you use an existing repository rather than a new one.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description:
        'Create a new private git repository for this user. Use it only when the work needs a ' +
        'repository that does not exist yet — check list_projects first. The repository belongs ' +
        'to the user you are talking to; you cannot see or touch anyone else\'s.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, e.g. "invoice-parser". Lowercased and hyphenated automatically.' },
          description: { type: 'string', description: 'One line on what it is for.' },
          language: {
            type: 'string',
            enum: Object.keys(WORKSPACE_IMAGES),
            description:
              'What this project is written in, so every persona working in it gets the right '
              + `toolchain. Defaults to "${DEFAULT_WORKSPACE_LANGUAGE}". `
              + Object.entries(WORKSPACE_IMAGES).map(([name, entry]) => `"${name}": ${entry.summary}`).join(' '),
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_leaf_project',
      description:
        'Attach a leaf to a project, so the work is done against that repository — it is cloned ' +
        'into the sandbox, and the agent commits and pushes to a branch. Work with no project ' +
        'runs in an empty sandbox and is thrown away when it finishes.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' },
          projectId: { type: 'string', description: 'The project id, as returned by list_projects.' },
        },
        required: ['id', 'projectId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_project_dependency',
      description:
        'Declare that this project depends on a running service, so its deployment is given the '
        + 'address and credentials for it. Call this before proposing work that connects to '
        + 'something — the leaf then reads the connection from $SERVICE_BINDING_ROOT at runtime '
        + 'rather than being told it now. The service must be one list_infrastructure reports.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project that needs it, from list_projects.' },
          service: { type: 'string', description: 'The running service to depend on, by name.' },
          as: {
            type: 'string',
            description:
              'Optional directory name under $SERVICE_BINDING_ROOT. Defaults to the service type. '
              + 'Give one only when a project needs two of the same kind.',
          },
        },
        required: ['projectId', 'service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_infrastructure',
      description:
        'What is running in the cluster that this work could use — databases, storage, search, '
        + 'embeddings — with the address a pod reaches each one at, and the full list of what this '
        + 'platform can deploy. Call this BEFORE proposing work that depends on a service. Anything '
        + 'in neither list does not exist here: say so rather than planning around it. Never '
        + 'hard-code an address into a leaf — a service a project depends on is provided to it as a '
        + 'binding at deploy time, read from $SERVICE_BINDING_ROOT at runtime.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_mcp_servers',
      description:
        'List the MCP servers deployed under your account and the tools each one exposes. These are '
        + 'real, running services — including ones built here — and a leaf that names a server in its '
        + 'body can call its tools while it runs. Call this before planning work that needs a '
        + 'capability, to find out whether it already exists. Each server also reports the projectId '
        + 'of the repository it is built from, so an existing server can be EXTENDED with '
        + 'set_leaf_project rather than replaced by a second one.',
      parameters: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description:
              'Re-introspect every server instead of using the cached tool list. Use after deploying '
              + 'or redeploying a server, when its tools may have changed.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_leaf_memory',
      description:
        'Record a persistent memory item (a lesson learned, environment fact, or prompt rule) in the Memory Bank.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'],
            description: 'Memory category.',
          },
          title: { type: 'string', description: 'Short descriptive title.' },
          text: { type: 'string', description: 'Detailed memory note.' },
        },
        required: ['category', 'title', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web for current information, documentation, package versions, or technical articles.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to look up on the web.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_web_page',
      description:
        'Fetch and extract clean text content from a web page URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
] as const;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ToolCallScanner {
  private byIndex = new Map<number, { id: string; name: string; args: string }>();
  private buffer = '';

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const calls = JSON.parse(payload)?.choices?.[0]?.delta?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const call of calls) {
          const index = Number(call?.index ?? 0);
          const existing = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
          this.byIndex.set(index, {
            id: call?.id || existing.id,
            name: call?.function?.name || existing.name,
            args: existing.args + (call?.function?.arguments ?? ''),
          });
        }
      } catch { /* ignored */ }
    }
  }

  result(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args }))
      .filter((c) => c.name);
  }
}

export function summariseLeaf(leaf: Leaf): Record<string, unknown> {
  return {
    id: leaf.id,
    title: leaf.title,
    status: leaf.status,
    ...(leaf.parentLeafId ? { parentLeafId: leaf.parentLeafId } : {}),
    ...(leaf.projectId ? { projectId: leaf.projectId } : {}),
    ...(leaf.attempts?.length ? { failedAttempts: leaf.attempts.length } : {}),
  };
}

export function detailLeaf(leaf: Leaf, children: Leaf[]): Record<string, unknown> {
  return {
    ...summariseLeaf(leaf),
    ...(leaf.body ? { body: leaf.body } : {}),
    ...(children.length ? { subLeaves: children.map(summariseLeaf) } : {}),
    ...(leaf.attempts?.length
      ? { attempts: leaf.attempts.map((a) => ({ attempt: a.attempt + 1, error: a.error })) }
      : {}),
  };
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const WEB_TOOLS = LEAF_TOOLS.filter((t) =>
  (WEB_TOOL_NAMES as readonly string[]).includes(t.function.name),
);

export const LEAF_TOOL_EFFECTS = {
  list_leaves: 'read',
  get_leaf: 'read',
  propose_leaf: 'write',
  set_acceptance: 'write',
  revise_leaf: 'write',
  replace_leaf: 'write',
  withdraw_leaf: 'write',
  start_ingest: 'write',
  ingest_status: 'read',
  search_corpus: 'read',
  list_personas: 'read',
  list_projects: 'read',
  create_project: 'write',
  set_leaf_project: 'write',
  add_project_dependency: 'write',
  list_infrastructure: 'read',
  list_mcp_servers: 'read',
  update_leaf_memory: 'write',
  web_search: 'read',
  fetch_web_page: 'read',
} satisfies Record<typeof LEAF_TOOLS[number]['function']['name'], ToolEffect>;
