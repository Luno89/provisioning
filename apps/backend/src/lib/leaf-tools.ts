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
import { WORKSPACE_IMAGES, DEFAULT_WORKSPACE_LANGUAGE, type WorkspaceLanguage } from './workspace-spec.js';

/**
 * The language parameter, shared by every tool that can set one.
 *
 * The catalogue is inlined as an `enum` with a description listing what each option contains,
 * rather than exposed as a `list_workspace_options` tool. Discovery-by-schema costs nothing: a
 * separate tool would spend one of only MAX_TOOL_ROUNDS round trips — a whole inference pass — to
 * learn a fixed list the model could have been handed up front.
 */
const LANGUAGE_PARAM = {
  type: 'string',
  enum: Object.keys(WORKSPACE_IMAGES),
  description:
    `Toolchain for the sandbox this work runs in. Defaults to "${DEFAULT_WORKSPACE_LANGUAGE}". ` +
    Object.entries(WORKSPACE_IMAGES).map(([name, entry]) => `"${name}": ${entry.summary}`).join(' '),
} as const;

/** Ceiling on tool round trips in one turn. A model that keeps calling tools without answering is
 *  a loop, and each round is a full inference pass. */
export const MAX_TOOL_ROUNDS = 4;

/** Definitions sent to the model, in OpenAI's function-calling shape. */
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
              + 'build on. Give the titles exactly as you proposed them.',
          },
          /**
           * A persona NAME, not an id — same reasoning as `dependsOn` taking titles. The model is
           * proposing several leaves in one turn and has no way to know an id; it knows the names
           * it was shown.
           */
          persona: {
            type: 'string',
            description:
              'Optional — the name of the persona best suited to this work, exactly as listed. '
              + 'Assign the one whose strengths match what the leaf actually requires; leave it out '
              + 'if no listed persona is a better fit than the default.',
          },
          language: LANGUAGE_PARAM,
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revise_leaf',
      description:
        'Change the title or description of a leaf that is still a PROPOSAL. Use this when asked ' +
        'to reword or expand something already proposed, instead of proposing a near-duplicate. ' +
        'Accepted or running work cannot be edited.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' },
          title: { type: 'string', description: 'Replacement title. Omit to leave it alone.' },
          body: { type: 'string', description: 'Replacement description. Omit to leave it alone.' },
        },
        required: ['id'],
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
      name: 'set_leaf_workspace',
      description:
        'Change which toolchain a leaf runs in. Use it when the language of a piece of work turns ' +
        'out to differ from what was assumed — the sandbox is created from this when the work starts.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id, as returned by list_leaves.' },
          language: LANGUAGE_PARAM,
        },
        required: ['id', 'language'],
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
      name: 'list_tool_repository',
      description:
        'List available execution tools in the Tool Repository (e.g. test runners, git inspectors, linter audit, http request testers). ' +
        'Use this to discover tools to attach to a leaf.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['testing', 'database', 'git', 'http', 'linter'],
            description: 'Optional category filter.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attach_tool_to_leaf',
      description:
        'Attach a tool from the Tool Repository to a leaf so its execution sandbox receives that tool capability.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The leaf id.' },
          toolId: { type: 'string', description: 'The tool id or function name from the Tool Repository.' },
        },
        required: ['id', 'toolId'],
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
    ...(leaf.language ? { language: leaf.language } : {}),
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
