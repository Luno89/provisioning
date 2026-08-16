/**
 * The tools an agent has INSIDE a sandbox.
 *
 * Deliberately four, and deliberately small. This set is the isolation boundary's other half: the
 * NetworkPolicy decides what the sandbox can reach, and this decides what the model can ask it to
 * do. Anything not expressible here is not reachable by a prompt, however that prompt got written
 * — which matters because the text driving this loop can include a repo the agent was told to read.
 *
 * There is no "install a package", no "start a server", no "call an API". A task needing one of
 * those should fail loudly rather than have the capability quietly added to every task.
 */
import { describeSandbox, type WorkspaceLanguage, imageForLanguage } from './workspace-spec.js';

/**
 * Ceiling on model↔sandbox round trips for one attempt. Each is a full inference pass plus a
 * command, so this bounds both spend and wall-clock.
 *
 * Raised from 24, which lost to exploration on any repository that already had content in it.
 * Measured on a five-leaf plan: one leaf spent its whole budget twice on `ls -la`, `cat
 * package.json`, `git log` and reading two source files, and never wrote the one small module it
 * was asked for. A later leaf did the same hunting for a test runner. Both tasks were minutes of
 * work; neither was short of ability, only of room.
 *
 * The real fix is the agent not needing to rediscover the same repository every time — see the
 * memory context threaded through ExecuteLeafActivity. This is the blunt half, and deliberately
 * still bounded: a leaf that cannot finish in 40 steps is not usually one step short.
 */
export const MAX_AGENT_STEPS = 40;

/**
 * The budget for a research leaf, which spends its steps differently.
 *
 * A coding leaf's steps go on a repository that is already in front of it. A research leaf has to
 * FIND its material first, and every search and every page fetch is a step that produces no
 * deliverable — then the writing still has to happen afterwards.
 *
 * Measured, twice, at 40: the agent searched and fetched until the budget was gone and never
 * finished. The first run wrote nothing at all; the second wrote a real 1,200-character answer and
 * ran out before adding the citations it had already fetched. Neither was short of ability, and
 * neither was one step short — the shape of the work simply costs more than reading a repo does.
 *
 * Still bounded, and still with the same wrap-up warning, because an agent that cannot answer in a
 * hundred steps is looping rather than working.
 */
export const RESEARCH_AGENT_STEPS = 100;

/**
 * How close to the cap the agent starts being warned.
 *
 * Enough room to commit and push (two commands) and still call `finish`, with one spare for the
 * command that fails first time. Warning earlier trains the model to ignore it.
 */
export const WRAPUP_STEPS = 4;

/** A thing to say to the agent once its remaining budget drops to `atRemaining`. */
export interface PacingNote {
  atRemaining: number;
  message: string;
}

/**
 * What a coding leaf is told as its budget runs out.
 *
 * Committing is how a coding leaf's work survives, so that is what the warning is about.
 */
export const CODE_PACING: PacingNote[] = [
  { atRemaining: WRAPUP_STEPS, message: 'Commit and push what you have NOW, then call `finish` — anything uncommitted is lost.' },
];

/**
 * What a research leaf is told, and much earlier.
 *
 * ── WHY THIS EXISTS ──
 * The default warning says "commit and push", which a research leaf cannot do and does not need —
 * it has no repository. It also arrives four steps from the end, which is far too late for the
 * failure that actually happens.
 *
 * Measured three times: the agent searches and fetches until the budget is gone and never writes.
 * Raising the budget from 40 to 100 did not help — it simply searched for 100 steps instead of 40
 * and still produced an empty file. The constraint is not room, it is that nothing ever tells the
 * agent to stop looking. So the first note lands at the halfway mark, where there is still time to
 * act on it.
 */
export function researchPacing(maxSteps: number, findingsPath: string): PacingNote[] {
  return [
    {
      atRemaining: Math.floor(maxSteps / 2),
      message:
        `Half your budget is gone. STOP SEARCHING NOW and write what you have to ${findingsPath}. `
        + 'You can search again afterwards if something is missing, but the file must exist first.',
    },
    {
      atRemaining: WRAPUP_STEPS,
      message:
        `Write ${findingsPath} NOW and call \`finish\`. It is the only thing kept — an answer that `
        + 'exists only in your replies is lost, and an empty file fails the leaf.',
    },
  ];
}

/**
 * Tools taken away partway through a run, and when.
 *
 * ── WHY INSTRUCTIONS WERE NOT ENOUGH ──
 * A research agent was told, in four separate ways, to stop searching and write: in the task
 * context, in a step budget it could see, in a halfway warning, and in a final one. Measured across
 * four runs on the local model, it searched until the budget was gone every single time and wrote
 * nothing — at 40 steps and again at 100, before and after the warnings existed.
 *
 * An agent that can search will keep searching, because the next page always looks like it might
 * help. Removing the tool is the only version of "stop now" that does not depend on the model
 * agreeing. It still has read_file, write_file and run_command, so the work it has left to do is
 * exactly the work it has been avoiding.
 */
export interface ToolWithdrawal {
  afterStep: number;
  names: readonly string[];
}

/** The tools available on a given step, given what has been withdrawn. */
export function toolsForStep<T extends { function: { name: string } }>(
  step: number,
  all: T[],
  withdrawal: ToolWithdrawal | undefined,
): T[] {
  if (!withdrawal || step < withdrawal.afterStep) return all;
  return all.filter((t) => !withdrawal.names.includes(t.function.name));
}

/**
 * The note to show at a given point, or nothing.
 *
 * The most urgent match wins: with several notes triggered, the one with the smallest threshold is
 * the one whose deadline is closest, and showing the gentler halfway message four steps from the
 * end would be actively misleading.
 */
export function pacingNoteFor(remaining: number, notes: PacingNote[]): PacingNote | undefined {
  if (remaining <= 0) return undefined;
  return notes
    .filter((n) => remaining <= n.atRemaining)
    .sort((a, b) => a.atRemaining - b.atRemaining)[0];
}

/** Tool results are fed back into context and billed by the token. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * How much of the conversation is sent back to the model.
 *
 * ── THE CEILING NOBODY WAS COUNTING ──
 * The loop appended every assistant turn and every tool result and re-sent the lot each step, so
 * the context grew without bound while the budget was counted in STEPS. The two are unrelated
 * numbers, and the model's window is the one that actually binds.
 *
 * Measured against the local TabbyAPI deployment, whose window is 32,768 tokens: a research run
 * raised to 100 steps died with "requires 34816 cache tokens, which exceeds the available context
 * size of 32768". At 8,000 characters per tool result, roughly sixteen full-size results fill that
 * window — so a hundred-step run could never have finished, and raising the step budget from 40 to
 * 100 made failure certain rather than more likely.
 *
 * Conservative on purpose: ~60k characters is roughly 15k tokens, leaving room for the system
 * prompt, the tool declarations and the reply on a 32k model.
 */
export const CONVERSATION_CHAR_BUDGET = 60_000;

/** What replaces an old tool result once it no longer fits. */
const DROPPED = '[earlier tool output dropped to fit the context window — re-run the tool if you still need it]';

/** What replaces the CONTENTS of a file already written, in an older turn. */
const WRITTEN = (path: string, bytes: number) =>
  `{"path":${JSON.stringify(path)},"content":"[${bytes} bytes already written to ${path} — read the file if you need it]"}`;

/**
 * The conversation as it should be SENT: recent turns intact, older bulk elided.
 *
 * ── WHY CONTENT IS REPLACED AND MESSAGES ARE NOT REMOVED ──
 * A `tool` message must stay paired with the assistant `tool_calls` entry that requested it;
 * deleting one and leaving the other is a malformed request that the API rejects outright. Blanking
 * the content keeps every pairing intact while reclaiming the space, which is where the space is.
 *
 * The first two messages are never touched — they are the system prompt and the task itself, and an
 * agent that loses the task will confidently do the wrong thing for the rest of its budget.
 */
/**
 * Replaces the `content` argument of any write_file call with a note, keeping everything else.
 *
 * Returns undefined when there is nothing worth eliding, so the caller can tell "trimmed" from
 * "unchanged" without comparing sizes.
 */
function elideWrites(m: { tool_calls?: unknown }): unknown | undefined {
  const calls = m.tool_calls as { function?: { name?: string; arguments?: string } }[] | undefined;
  if (!Array.isArray(calls) || !calls.length) return undefined;

  let changed = false;
  const next = calls.map((c) => {
    if (c?.function?.name !== 'write_file' || typeof c.function.arguments !== 'string') return c;
    let path = 'the file';
    let bytes = c.function.arguments.length;
    try {
      const args = JSON.parse(c.function.arguments);
      if (typeof args?.path === 'string') path = args.path;
      if (typeof args?.content === 'string') bytes = args.content.length;
      // Nothing to reclaim on a small write.
      if (bytes < 400) return c;
    } catch {
      // A truncated argument is still bulk worth reclaiming.
    }
    changed = true;
    return { ...c, function: { ...c.function, arguments: WRITTEN(path, bytes) } };
  });
  return changed ? { ...m, tool_calls: next } : undefined;
}

export function trimConversation<T extends { role?: string; content?: unknown }>(
  messages: T[],
  budget: number = CONVERSATION_CHAR_BUDGET,
): T[] {
  /**
   * How much room a message actually takes.
   *
   * `content` alone was measured, and a `write_file` call's arguments are not content — they live
   * on the assistant message's `tool_calls`, and they hold the whole file. So a conversation made
   * of file writes looked nearly empty to this budget while being the largest thing the model was
   * asked to read.
   *
   * Measured: a leaf rewrote a 9 KB test file three times and died on
   * `requires 34816 cache tokens, which exceeds the available context size of 32768`, with a
   * trimmer that believed the conversation was well inside its limit.
   */
  const size = (m: T) => {
    const content = typeof m.content === 'string' ? m.content.length : 0;
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    return content + (calls ? JSON.stringify(calls).length : 0);
  };
  const total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;

  const PRESERVE_HEAD = 2;
  const out = [...messages];
  // Newest first: the most recent exchanges are the ones the next decision depends on.
  let used = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (i < PRESERVE_HEAD) continue;
    const m = out[i]!;
    const len = size(m);
    if (used + len <= budget) { used += len; continue; }
    if (m.role === 'tool' && len > DROPPED.length) {
      // Tool output: dropped outright. It is recoverable by running the tool again.
      out[i] = { ...m, content: DROPPED };
      used += DROPPED.length;
      continue;
    }

    /**
     * An old `write_file` keeps its call and loses its payload.
     *
     * The reasoning that protected assistant turns is right about the THREAD — which tool was
     * called, with what path, in what order — and wrong about the file contents, which are the bulk
     * and which are already on disk. Keeping the call and eliding the content preserves what the
     * model needs to know it wrote the file, at a fraction of the room.
     */
    const trimmed = elideWrites(m as { tool_calls?: unknown });
    if (trimmed) {
      out[i] = trimmed as T;
      used += size(trimmed as T);
      continue;
    }

    used += len;
  }
  return out;
}

export const SANDBOX_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the sandbox and get back stdout, stderr and the exit code. Each ' +
        'call is a FRESH shell — `cd` and environment variables do not persist, so chain steps ' +
        'with && or use absolute paths.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command, e.g. "cd /work/app && npm test".' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a file, creating parent directories as needed. Replaces the whole file. Use this ' +
        'rather than shell heredocs, which mangle quotes and backticks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to /work, e.g. "src/index.ts".' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file back out of the sandbox.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to /work.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Call this when the task is complete, or when you are certain you cannot complete it. ' +
        'This ends the attempt — nothing runs afterwards, so verify your work BEFORE calling it.',
      parameters: {
        type: 'object',
        properties: {
          succeeded: { type: 'boolean', description: 'true if the task is done, false if you are stuck.' },
          summary: {
            type: 'string',
            description:
              'What you did, or why you could not. If you failed, be specific — this is the only ' +
              'thing the next attempt will know about this one.',
          },
        },
        required: ['succeeded', 'summary'],
      },
    },
  },
] as const;

/**
 * The agent's system prompt.
 *
 * Leads with the environment because that is what makes the difference between a first command
 * that works and one that discovers the sandbox has no network. `describeSandbox` generates it from
 * the same constants the pod is built from, so it cannot drift from reality.
 */
export function buildAgentPrompt(
  language: WorkspaceLanguage | undefined,
  taskContext: string,
  /**
   * The cap the LOOP will actually enforce, not the shipped constant.
   *
   * These were two different numbers. The prompt hardcoded MAX_AGENT_STEPS while the loop ran on
   * `maxSteps`, which `overrides.maxSteps` can change — so raising the cap told the agent nothing
   * and it kept budgeting for 24. The same shape as every other bug in this codebase where one
   * value was stated in two places: it typechecks, it runs, and the two quietly disagree.
   */
  maxSteps: number = MAX_AGENT_STEPS,
): string {
  return [
    'You are completing one piece of work inside a sandboxed container. You have shell access and',
    'can read and write files. Work autonomously — nobody is available to answer questions.',
    '',
    describeSandbox({ image: imageForLanguage(language) }),
    '',
    'HOW TO WORK',
    '- Look before you edit: list the directory and read a file rather than assuming its contents.',
    '- Verify your work by running it. A task is not done because the code looks right.',
    '- Call `finish` when done, or when genuinely stuck. Do not stop responding without calling it.',
    `- You have at most ${maxSteps} steps. Spend them on the task, not on exploring.`,
    '- Commit and push as you go. Work that is only in the container is lost if you run out of steps.',
    '',
    'YOUR TASK',
    taskContext,
  ].join('\n');
}

/**
 * Truncates a tool result from the FRONT, so the tail — where errors and exit codes live — survives.
 *
 * `max` admits undefined so a caller can pass an optional override straight through without having
 * to restate the default, which would be a second copy of it.
 */
export function clampToolResult(text: string, max: number | undefined = MAX_TOOL_RESULT_CHARS): string {
  const cap = max ?? MAX_TOOL_RESULT_CHARS;
  if (text.length <= cap) return text;
  return `…[${text.length - cap} characters truncated]\n${text.slice(-cap)}`;
}
