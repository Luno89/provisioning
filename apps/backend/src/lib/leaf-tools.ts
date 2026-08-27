import type { ToolEffect } from './action-gate.js';
import { WORKSPACE_IMAGES, DEFAULT_WORKSPACE_LANGUAGE } from './workspace-spec.js';
/**
 * Tools the model can call to inspect and grow a branch.
 *
 * Replaces guessing with asking. Two things were previously inferred from prose: what work already
 * exists (injected as a context dump every turn, whether or not it was wanted) and what work to
 * create (a JSON block parsed out of free text, which the conversation model emitted about one
 * time in eight). A tool call is structured by construction — the engine emits a name and typed
 * arguments, so there is nothing to parse defensively.
 *
 * Verified against the live TabbyAPI deployment: it returns finish_reason "tool_calls" with a
 * proper function name and arguments object.
 *
 * The definitions are kept pure and separate from execution so the schemas can be tested, and so
 * adding a tool does not mean touching the chat route.
 */
import type { Leaf } from './leaves.js';

/**
 * Ceiling on tool round trips in one turn. A model that keeps calling tools without answering is a
 * loop, and each round is a full inference pass.
 *
 * Raised from 4, which a real planning turn outgrew. Observed: the model read the board, inspected
 * two leaves, listed projects, attached one, and set the acceptance plan — six calls, and the last
 * TWO fell past the cap and were dropped while it reported having made them. A turn that
 * legitimately inspects before it acts needs room for both.
 */
export const MAX_TOOL_ROUNDS = 8;

/** Definitions sent to the model, in OpenAI's function-calling shape. */
/**
 * The two tools that reach the open web.
 *
 * Named separately from LEAF_TOOLS so the execution agent can be given exactly these without
 * inheriting the planner's board-editing tools. Both are dispatched in-process by the caller, so
 * a sandbox's egress policy does not apply to them.
 */
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
              // A wrong extension here failed a leaf three times whose work was complete and whose
              // suite was green, so say plainly which one to use. The system message for this turn
              // carries the project's conventions; this is the reminder at the point of writing.
              + 'Use the file extension and directory layout this project actually uses — they are '
              + 'stated above. Do not guess .ts for a JavaScript project.',
          },
          /**
           * Titles rather than ids, because the model is proposing several leaves in one turn and
           * does not yet know the ids of the ones it created moments ago. Resolved server-side
           * against this branch.
           */
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
          /**
           * Declared at proposal time, like `persona` and `mcp`, and for the same reason.
           *
           * The alternative — propose the leaf, then call `set_leaf_project` for it — is the
           * round-trip pattern that has failed twice now. Observed: the planner read
           * list_mcp_servers, correctly said "No need to rebuild it", quoted the project the
           * running server is built from, and then never pointed a single leaf at it. The work went
           * to a fresh repository and produced a second service under the same name.
           */
          projectId: {
            type: 'string',
            description:
              'Optional — the id of an existing project this work belongs in, from list_projects or '
              + 'the projectId reported by list_mcp_servers. Give it whenever the work CHANGES '
              + 'something that already exists: the leaf then checks out that repository, and '
              + 'merging rebuilds and redeploys it. Omit it for genuinely new work, which gets a '
              + 'repository of its own.',
          },
          /**
           * Named per leaf because a persona is written before anything is deployed, so it cannot
           * know the name of a server this very plan is about to build.
           */
          mcp: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional — names of MCP servers this leaf must CALL while it runs, from '
              + 'list_mcp_servers. Give these whenever the work uses a deployed service: without '
              + 'them the leaf has no tools for it and can only guess at HTTP. A server built '
              + 'earlier in this same plan can be named here by the leaf that verifies it.',
          },
          /**
           * A persona NAME, not an id — same reasoning as `dependsOn` taking titles. The model is
           * proposing several leaves in one turn and has no way to know an id; it knows the names
           * it was shown.
           */
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
        /**
         * Measured: the model wrote `cd /work && node verify-github-mcp.js`, and the file is at
         * /work/repo/verify-github-mcp.js. `buildAcceptanceScript` already cds into the repo, so
         * the model's own cd walked OUT of it and the check failed on a path rather than on the
         * product — a red verdict that says nothing about whether the work is good.
         */
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
          /**
           * A NAME, like propose_leaf takes — the model knows the names it was shown and has never
           * seen an id. Resolved server-side against this user's personas.
           */
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
        // Added after a live turn quoted a page as saying child workflows "will be closed" where
        // it actually said they "will not be retained" — sound retrieval, then a paraphrase
        // presented inside quotation marks, which is the one failure mode a cited answer must not
        // have.
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
          /**
           * The toolchain belongs to the PROJECT, not to whoever works in it.
           *
           * Every persona standing in a Go repository needs Go — the framer reading it, the builder
           * writing it, the merger running its tests. That is one fact about the project rather
           * than one about each of them.
           */
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
      /**
       * Declaring a dependency is what makes a service reachable. Without it a leaf can SEE that
       * mongo exists and has no way to say its project should be able to connect to one.
       */
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
      /**
       * Koala had this and the planning personas did not, so a planner could see MCP servers and
       * not the database sitting beside them. A leaf planned to "add caching" could not discover
       * that anything cacheable existed.
       */
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
      /**
       * ── WHAT THIS REPLACED ──
       * `list_tool_repository`, which returned six hardcoded strings — `pytest_runner`,
       * `git_inspector`, `linter_audit` — that no sandbox has ever had, alongside
       * `attach_tool_to_leaf`, which wrote the chosen id to `leaf.attachedTools`, a field NOTHING
       * reads. Asked what tools it could use, the model called it, got a confident list of fiction,
       * and never had any way to learn about the servers it had actually built and deployed.
       *
       * That is why "what MCP servers can you use?" got a wrong answer rather than a missing one:
       * the wrong answer was sitting where the right one should be.
       */
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
  /** Raw JSON string from the model; parsed by the executor, which must not trust it. */
  arguments: string;
}

/**
 * Accumulates tool calls from an SSE stream.
 *
 * Streamed tool calls arrive in fragments: the name comes on one delta and the arguments build up
 * character by character across many, keyed by index. Reading only the first delta gives a call
 * with empty arguments, which then executes with defaults and looks like the model asked for
 * something it did not.
 */
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
      } catch {
        // Partial frames are normal mid-stream.
      }
    }
  }

  result(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args }))
      // A call with no name is a fragment that never completed; executing it would be a guess.
      .filter((c) => c.name);
  }
}

/** Compact view of a leaf for a tool result. Bodies only on request, via get_leaf. */
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

/** Full view, including why it failed — the thing get_leaf exists for. */
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

/**
 * Parses a tool call's arguments.
 *
 * Returns an empty object rather than throwing: the arguments are model output, and a malformed
 * blob should make a tool run with defaults or report a clear error, never take down the turn.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The declarations for WEB_TOOL_NAMES, picked out of LEAF_TOOLS so there is only one copy. */
export const WEB_TOOLS = LEAF_TOOLS.filter((t) =>
  (WEB_TOOL_NAMES as readonly string[]).includes(t.function.name),
);

/**
 * What each planning tool DOES, for the Action Gate (`lib/action-gate.ts`).
 *
 * Read `lib/koala-tools.ts`' note on why this is a table rather than a field on the schema. The
 * classifications worth arguing with:
 *
 * · `propose_leaf`, `revise_leaf`, `replace_leaf`, `withdraw_leaf` and `set_acceptance` all write
 *   the board directly — they are NOT `propose`, despite the first one's name. A proposed leaf is
 *   real the moment it lands: the planner's output IS the plan, and nothing accepts it afterwards.
 *   Calling them `propose` would let a read-and-suggest context rewrite the board, which is the
 *   exact confusion the three categories exist to prevent. The name is the tool's, from the model's
 *   point of view; the effect is what the code does.
 *
 * · `start_ingest` writes, because it kicks off a job that fills a corpus. `ingest_status` and
 *   `search_corpus` only look at the result.
 *
 * · `update_leaf_memory` writes what the next attempt reads, which is precisely why it exists.
 */
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
