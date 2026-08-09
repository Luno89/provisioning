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
 * How close to the cap the agent starts being warned.
 *
 * Enough room to commit and push (two commands) and still call `finish`, with one spare for the
 * command that fails first time. Warning earlier trains the model to ignore it.
 */
export const WRAPUP_STEPS = 4;

/** Tool results are fed back into context and billed by the token. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

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
