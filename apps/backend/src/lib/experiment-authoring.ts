import type { TaskFile, WorkspaceLanguage  } from '@koala/harness-types';
import { describeSandbox } from './workspace-spec.js';
import { isWorkspaceLanguage } from './workspace-image-catalogue.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import { MAX_TASKS, MAX_TASK_CHARS, MAX_TASK_FILES, MAX_TASK_FILE_CHARS } from './experiments.js';
import type { ExperimentTask } from '@koala/harness-types';
import type { Database } from './db-interface.js';
import { withBuiltIns } from './ownership.js';

export const AUTHORING_SAMPLING = { template_vars: { enable_thinking: false } } as const;

export const AUTHORING_MAX_TOKENS = 3000;

export interface DraftTask {
  name: string;
  prompt: string;
  verifyCommand: string;
  seed?: TaskFile[];
  solution?: TaskFile[];
  language?: WorkspaceLanguage;
  planning?: boolean;
}

export interface AuthoredTasks {
  tasks: DraftTask[];
  rejected: { name: string; reason: string }[];
}

const MAX_NAME = 80;
const MAX_VERIFY = 2000;

const ALWAYS_PASSES = /^(true|:|exit\s+0|echo(\s|$)[^|&;]*)$/i;

const files = (raw: unknown): TaskFile[] =>
  (Array.isArray(raw) ? raw : [])
    .map((f: any) => ({ path: String(f?.path ?? '').trim(), content: String(f?.content ?? '') }))
    .filter((f) => f.path && !f.path.startsWith('/') && !f.path.includes('..'))
    .slice(0, 10);

const degenerate = (command: string): string | null => {
  const trimmed = command.trim();
  if (!trimmed) return 'has no verify command';
  if (ALWAYS_PASSES.test(trimmed)) return `verify command "${trimmed}" passes whatever the agent did`;
  return null;
};

export function buildTaskAuthorPrompt(
  images: readonly WorkspaceImageSpec[],
  opts: { existing?: string[] } = {},
): string {
  const languages = images.map((i) => `${i.id} (${i.summary})`).join('; ');

  return [
    'You are writing tasks for an evaluation suite. Each task is given to a coding agent working',
    'alone in a sandbox, and is scored by running a command afterwards.',
    '',
    'Propose tasks as a fenced json block:',
    '',
    '```json',
    '{"tasks":[{"name":"short label","prompt":"what the agent is asked to do",',
    '  "seed":[{"path":"data.txt","content":"any files that must already exist"}],',
    '  "solution":[{"path":"read.js","content":"a correct answer"}],',
    '  "verifyCommand":"shell command","language":"node"}]}',
    '```',
    '',
    'Rules:',
    `- At most ${MAX_TASKS} tasks. Propose fewer good ones rather than padding.`,
    '- Propose nothing if the goal is unclear. Ask a question instead.',
    '- Each task must be doable start to finish by one agent in a few minutes.',
    '',
    'SEED AND SOLUTION',
    '- `seed` is what already exists in /work when the agent starts. If your prompt says "read',
    '  data.txt" or "fix the bug in sum.js", that file MUST be in the seed — the agent has nothing',
    '  else. A verify command that creates its own input does not count: the agent never sees it.',
    '- `solution` is a correct answer. It is never given to the agent; it exists so the verify',
    '  command can be run against a known-good result and proved capable of passing. A command that',
    '  fails on a correct solution is broken, and without a solution nobody can tell.',
    '- Both are optional. A task that starts from nothing needs no seed.',
    '',
    'THE VERIFY COMMAND IS THE PART THAT MATTERS',
    '- It runs in the sandbox AFTER the agent stops. Exit 0 means the task was done.',
    '- It must check the ARTEFACT, not the agent\'s word: run the code, read the file, diff output.',
    '- It MUST FAIL with only the seed present, and MUST PASS with seed + solution. Both are run',
    '  and checked. A command that passes with no work done checks nothing; one that fails on a',
    '  correct solution is simply wrong.',
    '- Never use `true`, `echo ok`, or `exit 0`.',
    '- Prefer a command that is silent on success and loud on failure, e.g.',
    '  `cd /work && node test.js` or `cd /work && test -f out.txt && grep -q EXPECTED out.txt`.',
    '',
    `Languages available: ${languages}.`,
    '',
    ...(opts.existing?.length
      ? [
          'The suite already contains these tasks. Propose different ones rather than restating them:',
          ...opts.existing.slice(0, MAX_TASKS).map((n) => `- ${n}`),
          '',
        ]
      : []),
    describeSandbox(images),
  ].join('\n');
}

export function buildTaskChatPrompt(images: readonly WorkspaceImageSpec[], task: DraftTask): string {
  return [
    'You are helping write ONE task for an evaluation suite. Discuss it naturally.',
    '',
    'When you want to change the task, end your reply with a fenced json block containing only the',
    'fields you are changing:',
    '',
    '```json',
    '{"task":{"prompt":"...","verifyCommand":"...","seed":[{"path":"a.txt","content":"..."}],'
      + '"solution":[{"path":"b.js","content":"..."}]}}',
    '```',
    '',
    'Rules:',
    '- Propose no block if you are only answering a question or asking one.',
    '- Change as little as possible. Omit fields you are not touching.',
    '- `seed` is what exists in /work BEFORE the agent starts. If the prompt refers to a file, that',
    '  file must be in the seed — a verify command that creates its own input does not count,',
    '  because the agent never sees it.',
    '- `solution` is a correct answer, used only to prove the verify command can pass. It is never',
    '  given to the agent.',
    '- The verify command must FAIL with only the seed present and PASS with seed + solution.',
    '',
    'THE TASK AS IT STANDS',
    `name: ${task.name}`,
    `prompt: ${task.prompt}`,
    `verifyCommand: ${task.verifyCommand}`,
    `seed: ${JSON.stringify(task.seed ?? [])}`,
    `solution: ${JSON.stringify(task.solution ?? [])}`,
    '',
    describeSandbox(images),
  ].join('\n');
}

export function extractTaskRevision(images: readonly WorkspaceImageSpec[], reply: string): Partial<DraftTask> | null {
  const found = findTaskObject(reply, 'task');
  if (!found) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(found.json);
  } catch {
    return null;
  }
  const raw = parsed?.task;
  if (!raw || typeof raw !== 'object') return null;

  const out: Partial<DraftTask> = {};
  if (typeof raw.prompt === 'string' && raw.prompt.trim()) out.prompt = raw.prompt.slice(0, MAX_TASK_CHARS);
  if (typeof raw.verifyCommand === 'string' && raw.verifyCommand.trim()) {
    out.verifyCommand = raw.verifyCommand.trim().slice(0, MAX_VERIFY);
  }
  if (Array.isArray(raw.seed)) out.seed = files(raw.seed);
  if (Array.isArray(raw.solution)) out.solution = files(raw.solution);
  if (isWorkspaceLanguage(images, raw.language)) out.language = raw.language;
  return Object.keys(out).length ? out : null;
}

function findTaskObject(
  reply: string,
  key: 'tasks' | 'task' = 'tasks',
): { start: number; end: number; json: string } | null {
  for (let i = reply.indexOf('{'); i !== -1; i = reply.indexOf('{', i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < reply.length; j++) {
      const ch = reply[j]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const json = reply.slice(i, j + 1);
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            const payload = parsed?.[key];
            const usable = key === 'tasks' ? Array.isArray(payload) : Boolean(payload) && typeof payload === 'object';
            if (usable) return { start: i, end: j + 1, json };
          } catch { /* ignored */ }
          break;
        }
      }
    }
  }
  return null;
}

export function extractTaskProposals(images: readonly WorkspaceImageSpec[], reply: string): AuthoredTasks {
  const out: AuthoredTasks = { tasks: [], rejected: [] };
  if (!reply) return out;

  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
  const found = findTaskObject(reply);
  if (found) blocks.push(found.json);

  const seen = new Set<string>();

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue; // Prose, a code sample, or truncated output — not a proposal.
    }

    const tasks = (parsed as { tasks?: unknown })?.tasks;
    if (!Array.isArray(tasks)) continue;

    for (const raw of tasks) {
      const name = String((raw as any)?.name ?? '').trim().slice(0, MAX_NAME);
      const prompt = String((raw as any)?.prompt ?? '').trim().slice(0, MAX_TASK_CHARS);
      const verifyCommand = String((raw as any)?.verifyCommand ?? '').trim().slice(0, MAX_VERIFY);
      const language = (raw as any)?.language;

      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      if (!prompt) {
        out.rejected.push({ name, reason: 'has no prompt' });
        continue;
      }
      const bad = degenerate(verifyCommand);
      if (bad) {
        out.rejected.push({ name, reason: bad });
        continue;
      }

      out.tasks.push({
        name,
        prompt,
        verifyCommand,
        ...(files((raw as any)?.seed).length ? { seed: files((raw as any)?.seed) } : {}),
        ...(files((raw as any)?.solution).length ? { solution: files((raw as any)?.solution) } : {}),
        ...(isWorkspaceLanguage(images, language) ? { language } : {}),
      });

      if (out.tasks.length >= MAX_TASKS) return out;
    }
  }

  return out;
}

export interface EmptyRunOutcome {
  ok: boolean;
  reason?: string;
}

export function judgeSolutionRun(result: { exitCode: number; timedOut: boolean }): EmptyRunOutcome {
  if (result.timedOut) return { ok: false, reason: 'hung on a correct solution' };
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `fails even on a correct solution (exit ${result.exitCode}) — the command is wrong, `
        + 'not the task',
    };
  }
  return { ok: true };
}

export function judgeEmptyRun(result: { exitCode: number; timedOut: boolean }): EmptyRunOutcome {
  if (result.timedOut) {
    return { ok: false, reason: 'hung on an empty workspace instead of failing' };
  }
  if (result.exitCode === 0) {
    return { ok: false, reason: 'passes on an empty workspace, so it is not checking anything' };
  }
  if (result.exitCode === 127) {
    return { ok: false, reason: 'exited 127 (command not found) — the sandbox has no such tool' };
  }
  return { ok: true };
}

export function selfProvisionedInputs(prompt: string, createdByVerify: string[]): string[] {
  return createdByVerify.filter((file) => {
    const base = file.replace(/^.*\//, '');
    if (!base) return false;
    return new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prompt);
  });
}

export function stripTaskBlock(reply: string): string {
  const found = findTaskObject(reply);
  if (!found) return reply.trim();

  const head = reply.slice(0, found.start).replace(/```(?:json)?[ \t]*\r?\n?$/i, '');
  const tail = reply.slice(found.end).replace(/^\s*```/, '');
  return (head + tail).trim();
}

export const normaliseTasks = (images: readonly WorkspaceImageSpec[], tasks: any[]): ExperimentTask[] =>
  tasks.slice(0, MAX_TASKS).map((t: any, i: number) => ({
    id: `t${i + 1}`,
    name: String(t?.name ?? '').trim().slice(0, 80) || `Task ${i + 1}`,
    prompt: String(t?.prompt ?? '').slice(0, MAX_TASK_CHARS),
    verifyCommand: String(t?.verifyCommand ?? '').trim().slice(0, 2000),
    ...(Array.isArray(t?.seed) && t.seed.length ? { seed: taskFiles(t.seed) } : {}),
    ...(Array.isArray(t?.solution) && t.solution.length ? { solution: taskFiles(t.solution) } : {}),
    ...(isWorkspaceLanguage(images, t?.language) ? { language: t.language } : {}),
    ...(t?.planning === true || t?.kind === 'planning' ? { planning: true } : {}),
  }));

export const taskFiles = (raw: any[]): { path: string; content: string }[] =>
  raw
    .slice(0, MAX_TASK_FILES)
    .map((f: any) => ({
      path: String(f?.path ?? '').trim(),
      content: String(f?.content ?? '').slice(0, MAX_TASK_FILE_CHARS),
    }))
    .filter((f) => f.path && !f.path.startsWith('/') && !f.path.includes('..'));

/**
 * Was checking `variant.personaId` against `db.getPersonas()` — `ExperimentVariant` declares only
 * `packId`, so `wanted` was always empty and this never actually validated anything. An arm naming
 * a deleted pack saved cleanly and only failed once the experiment tried to run it.
 */
export const unknownPack = async (db: Pick<Database, 'getPersonaPacks'>, userId: string, variants: unknown): Promise<string | undefined> => {
  if (!Array.isArray(variants)) return undefined;
  const wanted = variants
    .map((v) => (v && typeof v === 'object' ? (v as any).packId : undefined))
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (!wanted.length) return undefined;
  const mine = new Set(withBuiltIns(await db.getPersonaPacks(), userId, (p) => p.slug).map((p) => p.id));
  const missing = wanted.find((id) => !mine.has(id));
  return missing ? `No pack ${missing} — it may have been deleted.` : undefined;
};
