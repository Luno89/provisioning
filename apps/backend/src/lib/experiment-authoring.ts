/**
 * Koala writing the experiments.
 *
 * ── WHY THIS MIRRORS PLAN MODE RATHER THAN INVENTING A FORMAT ──
 * `plan-mode.ts` already solved "model proposes structured work, human accepts": ask for a fenced
 * JSON block, read it defensively, render the results as proposals. That shape was chosen because
 * a fenced block is the one structure small local models reliably produce, and because it survives
 * the prose they wrap around it. Both facts are as true here, so this deliberately copies the
 * approach — including returning nothing rather than guessing.
 *
 * ── THE VERIFY COMMAND IS THE DANGEROUS FIELD ──
 * Everything else a model gets wrong here is visible: a vague prompt reads as vague. A verify
 * command that always exits zero is invisible, and it makes every variant pass — which is the exact
 * failure the whole Lab exists to catch, now generated automatically and at scale.
 *
 * So there are two gates, and only the second one is real:
 *
 *   1. The static check below rejects the laziest degenerate commands (`true`, `echo ok`, `exit 0`).
 *      It is a filter, not a guarantee — shell is not statically analysable and pretending
 *      otherwise would be worse than having no check at all.
 *   2. Running the command in a FRESH, EMPTY sandbox and requiring it to FAIL. A verify command
 *      that passes with no work done is not checking anything. That gate is Phase 2 and lives with
 *      the sandbox; nothing here should be read as making a task safe to trust.
 *
 * The prompt teaches the property anyway, because a model told what will be checked writes better
 * commands than one filtered afterwards.
 *
 * Pure, so the extraction can be tested without a model.
 */
import type { TaskFile, WorkspaceLanguage } from '@koala/harness-types';
import { describeSandbox, WORKSPACE_IMAGES, isWorkspaceLanguage } from './workspace-spec.js';
import { MAX_TASKS, MAX_TASK_CHARS } from './experiments.js';

/**
 * Sampling for an authoring turn: reasoning OFF.
 *
 * Not the choice plan mode makes, and the difference is the point. A planning conversation keeps
 * reasoning on because that is what makes it worth talking to; authoring is one-shot structured
 * output, which is the case `sampling.ts` measured reasoning actively hurting — "structured output
 * went from about one reply in eight to three out of three".
 *
 * Measured again here, on this prompt: with reasoning on, the model produced 16,664 characters of
 * deliberation, hit `finish_reason: length` at a 4,000-token budget and emitted NO answer at all.
 * With it off the same request returned a clean block in 322 characters. Raising the budget is the
 * wrong fix — it buys more deliberation, not an answer.
 *
 * Spread over `conversationSampling(kind)` by the caller, which supplies the loop guards.
 */
export const AUTHORING_SAMPLING = { template_vars: { enable_thinking: false } } as const;

/** Budget for one authoring turn. Ample with reasoning off — a full suite lands in well under this. */
export const AUTHORING_MAX_TOKENS = 3000;

/** A task as proposed. No id — the server assigns those when the experiment is created. */
export interface DraftTask {
  name: string;
  prompt: string;
  verifyCommand: string;
  /** Present before the agent starts — the given state a task can describe work ON. */
  seed?: TaskFile[];
  /** A correct answer, used only to prove the verify command can pass. Never given to the agent. */
  solution?: TaskFile[];
  language?: WorkspaceLanguage;
}

/**
 * What a reply yielded.
 *
 * Rejections are returned rather than silently dropped. A batch where half the proposals had no
 * verify command is a fact about how the model is coping with the hardest field, and hiding it
 * would leave someone wondering why they asked for six tasks and got three.
 */
export interface AuthoredTasks {
  tasks: DraftTask[];
  rejected: { name: string; reason: string }[];
}

/** Matches the caps the create route enforces, so nothing proposed here is rejected there. */
const MAX_NAME = 80;
const MAX_VERIFY = 2000;

/**
 * Commands that pass whatever the agent did.
 *
 * Narrow on purpose. These are the cases a model reaches for when it cannot think of a real check,
 * and they are recognisable without parsing shell. Anything subtler is Phase 2's job — a regex that
 * tried to be clever here would reject working commands and still miss the interesting failures.
 */
const ALWAYS_PASSES = /^(true|:|exit\s+0|echo(\s|$)[^|&;]*)$/i;

/** File lists, read defensively — anything without a path is unusable and is dropped. */
const files = (raw: unknown): TaskFile[] =>
  (Array.isArray(raw) ? raw : [])
    .map((f: any) => ({ path: String(f?.path ?? '').trim(), content: String(f?.content ?? '') }))
    .filter((f) => f.path && !f.path.startsWith('/') && !f.path.includes('..'))
    .slice(0, 10);

const degenerate = (command: string): string | null => {
  const trimmed = command.trim();
  if (!trimmed) return 'has no verify command';
  // Only when the WHOLE command is degenerate: `echo x && node t.js` is a real check.
  if (ALWAYS_PASSES.test(trimmed)) return `verify command "${trimmed}" passes whatever the agent did`;
  return null;
};

/**
 * What Koala is told when asked to write a suite.
 *
 * Carries the real sandbox description for the same reason `PLAN_SYSTEM_PROMPT` does: the model
 * deciding what the work IS needs the constraints more than the executor does, because an executor
 * handed an impossible task can only fail it. A task proposing `npm install` cannot be rescued.
 */
export function buildTaskAuthorPrompt(opts: { existing?: string[] } = {}): string {
  const languages = (Object.keys(WORKSPACE_IMAGES) as WorkspaceLanguage[])
    .map((id) => `${id} (${WORKSPACE_IMAGES[id].summary})`)
    .join('; ');

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
    // The executor's constraints, verbatim from the pod spec — so a proposal cannot depend on
    // something the sandbox does not have.
    describeSandbox(),
  ].join('\n');
}

/**
 * Talking to Koala about ONE task.
 *
 * ── WHY A CONVERSATION AND NOT ANOTHER ONE-SHOT ──
 * The four parts of a task are interdependent, and generating them in one pass produced exactly the
 * incoherence you would expect: a prompt saying "read data.txt" beside a verify command that
 * created data.txt itself, because nothing forced the two to be considered together. Iterating is
 * how that gets resolved — you say "the agent never sees that file", and the seed appears.
 *
 * The current task travels in the system prompt rather than being restated each turn, so the model
 * is always revising something concrete rather than inventing from the last thing it said.
 */
export function buildTaskChatPrompt(task: DraftTask): string {
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
    describeSandbox(),
  ].join('\n');
}

/**
 * Reads a task revision out of a reply.
 *
 * Returns only the fields the model actually set, so accepting a revision changes exactly what was
 * discussed — a merge that filled in omitted fields with defaults would quietly undo edits the
 * conversation never mentioned.
 */
export function extractTaskRevision(reply: string): Partial<DraftTask> | null {
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
  if (isWorkspaceLanguage(raw.language)) out.language = raw.language;
  return Object.keys(out).length ? out : null;
}

/**
 * Locates the proposal object in a reply, by matching braces rather than by regex.
 *
 * The single source of truth for "where is the payload", used by both extraction and stripping so
 * the two cannot disagree about what counted as a proposal — a disagreement that showed up as the
 * whole JSON blob landing in the transcript after a successful parse.
 *
 * Brace counting rather than `\{[\s\S]*\}` because the payload legitimately contains braces inside
 * strings, and a task prompt legitimately contains fenced code samples. A greedy regex swallows a
 * following code block; a lazy one stops inside the first nested fence. Neither survives contact
 * with what the model actually writes.
 */
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
          // Only an object that actually parses AND carries tasks. Anything else is a brace in
          // prose, and scanning continues from the next one.
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            const payload = parsed?.[key];
            // `tasks` must be a list; `task` is a single object. Anything else is a brace in prose.
            const usable = key === 'tasks' ? Array.isArray(payload) : Boolean(payload) && typeof payload === 'object';
            if (usable) return { start: i, end: j + 1, json };
          } catch {
            // Not JSON — keep looking.
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Reads task proposals out of a model reply.
 *
 * Returns nothing it cannot confidently read. No proposals is always a valid outcome, so there is
 * never a reason to guess — the same rule `extractProposals` follows, and for the same reason: a
 * half-understood task costs a sandbox to discover it was nonsense.
 */
export function extractTaskProposals(reply: string): AuthoredTasks {
  const out: AuthoredTasks = { tasks: [], rejected: [] };
  if (!reply) return out;

  // Every fenced block, not just the last: models emit an illustrative block mid-reply and the
  // real one at the end about as often as the reverse.
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
  /**
   * The brace-matched object, tried last whatever the fences did.
   *
   * This used to run only when there were NO fenced blocks, which fails on the case that actually
   * occurs: a task whose PROMPT contains a fenced code sample. The inner fences then match first,
   * the outer JSON is sliced into fragments that parse as nothing, and because `blocks` was
   * non-empty the fallback never ran — so a perfectly good suite extracted as zero tasks and zero
   * rejections, which reads as the model having proposed nothing.
   */
  const found = findTaskObject(reply);
  if (found) blocks.push(found.json);

  /**
   * First occurrence of a name wins.
   *
   * Needed because the fallback above deliberately re-reads the whole reply, so a well-formed
   * fenced block is now parsed twice — and worth having anyway, since a model that repeats a task
   * would otherwise produce two identical rows the matrix could not tell apart.
   */
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

      // Unnamed and unusable are different: an unnamed proposal cannot even be reported on.
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
        ...(isWorkspaceLanguage(language) ? { language } : {}),
      });

      // The ceiling counts ACCEPTED tasks. Rejections keep accumulating so the caller can still
      // say what happened to the rest of the batch.
      if (out.tasks.length >= MAX_TASKS) return out;
    }
  }

  return out;
}

/**
 * What running a verify command against an EMPTY workspace proved.
 *
 * The real gate. A verify command exists to distinguish work-done from work-not-done, so running
 * it where nothing has been done must FAIL — and a command that passes there passes always, making
 * every variant in every experiment score a win. That is the precise failure the Lab exists to
 * catch, so generating tasks without this check would automate producing it.
 *
 * Pure, so the rules are testable without a cluster; the sandbox half lives in AuthoringService.
 */
export interface EmptyRunOutcome {
  /** True when the command correctly failed, and the task can be offered. */
  ok: boolean;
  reason?: string;
}

/**
 * What running the verify command against a CORRECT answer proved.
 *
 * ── THE HALF THAT WAS MISSING ──
 * `judgeEmptyRun` proves a verify command is not vacuous. Nothing proved it could ever pass. A
 * command with a typo — `grep -q 'Hello Wolrd'` — fails on the seed AND fails on a perfect
 * solution, and those two look identical from one side. Every variant then fails a task nothing
 * could win, at a sandbox per variant per repeat, and the matrix reports it as a hard question
 * rather than a broken one.
 *
 * Running it against seed + solution is what turns "achievable" from an assumption into a fact.
 */
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
    // It will hang on every real run too, burning the variant timeout for nothing.
    return { ok: false, reason: 'hung on an empty workspace instead of failing' };
  }
  if (result.exitCode === 0) {
    return { ok: false, reason: 'passes on an empty workspace, so it is not checking anything' };
  }
  if (result.exitCode === 127) {
    /**
     * Failed, but for the wrong reason.
     *
     * 127 is the shell's "command not found", so this command would fail identically on a run
     * where the agent did everything right — the task could never pass. The images genuinely lack
     * common tools (`jq` is absent from all four), which is exactly how this happens.
     */
    return { ok: false, reason: 'exited 127 (command not found) — the sandbox has no such tool' };
  }
  return { ok: true };
}

/**
 * Files a verify command creates for itself, which the agent will never have seen.
 *
 * ── THE SECOND WAY A TASK IS UNANSWERABLE ──
 * `judgeEmptyRun` proves a verify command is not vacuous. It cannot prove the task is answerable,
 * and those are different questions. Observed on a real authored suite:
 *
 *     prompt: "read /work/data.txt and print its contents"
 *     verify: cd /work && echo 'test data' > data.txt && node read.js | grep -q 'test data'
 *
 * That verify fails correctly on an empty workspace, so the gate passed it. But `data.txt` is
 * created BY THE VERIFY COMMAND — during the run there is nothing to read. The agent burned all 24
 * steps trying to invent the input, and the task could never have passed however well it worked.
 *
 * A file the verify command creates is a file the agent does not get. When the prompt names one, it
 * is describing a world the agent never sees.
 */
export function selfProvisionedInputs(prompt: string, createdByVerify: string[]): string[] {
  return createdByVerify.filter((file) => {
    const base = file.replace(/^.*\//, '');
    if (!base) return false;
    // Word-boundary match on the bare filename: a prompt saying "read data.txt" is describing an
    // input, while one that never mentions it is probably just letting verify build scaffolding.
    return new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prompt);
  });
}

/**
 * Strips the proposal block out of the reply shown to the user.
 *
 * The tasks are rendered as cards in their own right, so leaving the raw JSON in the transcript
 * shows the same thing twice — once as machinery nobody asked to see.
 *
 * ── THE FENCE IS OFTEN NOT CLOSED ──
 * Measured against the live deployment: the model opens ```json, emits the object, and stops —
 * `finish_reason: stop`, no closing fence, nothing truncated. Extraction already tolerated that
 * through its bare-object fallback, so the block parsed fine and then survived stripping intact,
 * putting the whole payload in the transcript. Stripping has to be exactly as forgiving as
 * extraction, or the two disagree about what counted as a proposal.
 */
export function stripTaskBlock(reply: string): string {
  const found = findTaskObject(reply);
  // No payload means nothing to hide — an ordinary reply is returned untouched.
  if (!found) return reply.trim();

  // The fence markers around it, when there are any. Both are optional and independently so: this
  // model routinely opens ```json and never closes it.
  const head = reply.slice(0, found.start).replace(/```(?:json)?[ \t]*\r?\n?$/i, '');
  const tail = reply.slice(found.end).replace(/^\s*```/, '');
  return (head + tail).trim();
}
