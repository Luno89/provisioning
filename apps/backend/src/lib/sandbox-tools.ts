import { describeSandbox, type WorkspaceLanguage, type WorkspaceSpec } from './workspace-spec.js';
import { imageForLanguage } from './workspace-image-catalogue.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import { FALLBACK_CONTEXT_TOKENS } from './sampling.js';

export const MAX_AGENT_STEPS = 200;

export const MAX_AGENT_TOKENS = 1_000_000;

export const RESEARCH_AGENT_STEPS = 100;

export const WRAPUP_STEPS = 4;

export interface PacingNote {
  atRemaining: number;
  message: string;
}

export const CODE_PACING: PacingNote[] = [
  { atRemaining: WRAPUP_STEPS, message: 'Commit and push what you have NOW, then call `finish` — anything uncommitted is lost.' },
];

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

export interface ToolWithdrawal {
  afterStep: number;
  names: readonly string[];
}

export function toolsForStep<T extends { function: { name: string } }>(
  step: number,
  all: T[],
  withdrawal: ToolWithdrawal | undefined,
): T[] {
  if (!withdrawal || step < withdrawal.afterStep) return all;
  return all.filter((t) => !withdrawal.names.includes(t.function.name));
}

export function pacingNoteFor(remaining: number, notes: PacingNote[]): PacingNote | undefined {
  if (remaining <= 0) return undefined;
  return notes
    .filter((n) => remaining <= n.atRemaining)
    .sort((a, b) => a.atRemaining - b.atRemaining)[0];
}

export const MAX_TOOL_RESULT_CHARS = 8_000;

export const CONVERSATION_CHAR_BUDGET = 60_000;

const CHARS_PER_TOKEN = 4;

const RETENTION_FRACTION = CONVERSATION_CHAR_BUDGET / (FALLBACK_CONTEXT_TOKENS * CHARS_PER_TOKEN);

export const DEFAULT_CONVERSATION_GROWTH = 2;

export function conversationBudget(
  contextTokens: number = FALLBACK_CONTEXT_TOKENS,
  growth: number = DEFAULT_CONVERSATION_GROWTH,
): number {
  const proportional = Math.floor(contextTokens * CHARS_PER_TOKEN * RETENTION_FRACTION);
  return Math.max(CONVERSATION_CHAR_BUDGET, Math.min(proportional, CONVERSATION_CHAR_BUDGET * growth));
}

const DROPPED = '[earlier tool output dropped to fit the context window — re-run the tool if you still need it]';

const WRITTEN = (path: string, bytes: number) =>
  `{"path":${JSON.stringify(path)},"content":"[${bytes} bytes already written to ${path} — read the file if you need it]"}`;

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
      if (bytes < 400) return c;
    } catch { /* ignored */ }
    changed = true;
    return { ...c, function: { ...c.function, arguments: WRITTEN(path, bytes) } };
  });
  return changed ? { ...m, tool_calls: next } : undefined;
}

export function trimConversation<T extends { role?: string; content?: unknown }>(
  messages: T[],
  budget: number = CONVERSATION_CHAR_BUDGET,
): T[] {
  const size = (m: T) => {
    const content = typeof m.content === 'string' ? m.content.length : 0;
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    return content + (calls ? JSON.stringify(calls).length : 0);
  };
  const total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;

  const PRESERVE_HEAD = 2;
  const out = [...messages];
  let used = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (i < PRESERVE_HEAD) continue;
    const m = out[i]!;
    const len = size(m);
    if (used + len <= budget) { used += len; continue; }
    if (m.role === 'tool' && len > DROPPED.length) {
      out[i] = { ...m, content: DROPPED };
      used += DROPPED.length;
      continue;
    }

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


export function buildAgentPrompt(
  images: readonly WorkspaceImageSpec[],
  language: WorkspaceLanguage | undefined,
  taskContext: string,
  maxSteps: number = MAX_AGENT_STEPS,
  sandbox: Pick<WorkspaceSpec, 'egress' | 'env' | 'cpu' | 'memory'> = {},
): string {
  return [
    'You are completing one piece of work inside a sandboxed container. You have shell access and',
    'can read and write files. Work autonomously — nobody is available to answer questions.',
    '',
    describeSandbox(images, { ...sandbox, image: imageForLanguage(images, language) }),
    '',
    'HOW TO WORK',
    '- Look before you edit: list the directory and read a file rather than assuming its contents.',
    '- Verify your work by running it. A task is not done because the code looks right.',
    '- Call `finish` when done, or when genuinely stuck. Do not stop responding without calling it.',
    `- Work at a steady pace, up to ${maxSteps} steps. Spend them on the task, not on exploring.`,
    '- If you finish, call `finish` immediately — do not keep looking for more to do.',
    '- Commit and push as you go. Work that is only in the container is lost if you run out of steps.',
    '',
    'YOUR TASK',
    taskContext,
  ].join('\n');
}

export function clampToolResult(text: string, max: number | undefined = MAX_TOOL_RESULT_CHARS): string {
  const cap = max ?? MAX_TOOL_RESULT_CHARS;
  if (text.length <= cap) return text;
  return `…[${text.length - cap} characters truncated]\n${text.slice(-cap)}`;
}
