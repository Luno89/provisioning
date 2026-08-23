/**
 * Phase checkpoints: one operation that does three jobs.
 *
 * A checkpoint COMMITS AND PUSHES what exists, REPLACES the conversation with a written record of
 * it, and takes a PROGRESS SAMPLE. Those are usually built as three mechanisms with three sets of
 * trigger logic; they are one here because they want to happen at the same moment and because
 * splitting them is how you end up with a context reset that discards work nobody saved.
 *
 * ── THE TWO FAILURES THIS ADDRESSES ──
 * · A run has no durability within itself. ExecuteLeafActivity is ONE Temporal activity wrapping up
 *   to MAX_AGENT_STEPS steps, so a crash — or, far more often, the activity's own wall-clock
 *   timeout — restarts at step zero. `/work` is an emptyDir, and the only push is the agent doing
 *   it at the end, so an interrupted run loses the tokens AND every file written.
 * · The context loses its middle. `trimConversation` blanks old tool output and elides write
 *   payloads; there is no summarisation and no reset. What the agent decided in turn 12 is simply
 *   gone by turn 60, while the prompt keeps growing.
 *
 * Git is already the durable store and already the inter-leaf hand-off (see leaf-checkout.ts), so a
 * checkpoint writes a markdown artifact INTO THE REPOSITORY and commits it. That makes it survive
 * the pod, readable in Gitea without cloning, and available to the next attempt through the clone
 * that already happens — no new collection, no new workflow argument.
 *
 * ── WHY THE AGENT DOES NOT DECIDE WHEN ──
 * It would be a natural-looking tool. sandbox-tools.ts records four measured runs where an agent
 * told in four separate ways to stop searching searched until its budget was gone; tool WITHDRAWAL
 * exists in this codebase precisely because instruction did not work. A `checkpoint` tool is an
 * instruction with a nicer interface, and an agent that does call it will call it constantly,
 * because it is a free-feeling way to look productive. The harness decides when. The agent decides
 * what goes in it, which is the part only it knows.
 *
 * Everything here is pure. When to fire and what the document says are the parts that are cheap to
 * get wrong and expensive to debug once real work runs through them — the same reason leaves.ts is
 * pure.
 */
import type { VerifyOutcome } from './leaf-verify.js';

/**
 * How many times a run pauses to write itself down.
 *
 * Two, so a default run checkpoints at roughly a third and two thirds of its token budget. More
 * would spend real inference on bookkeeping — each one costs a forced model turn plus a sandbox
 * round trip — and fewer would leave too much work exposed between saves.
 */
export const CHECKPOINTS = 2;

/**
 * Below this much remaining budget, skip it.
 *
 * The forced wrap-up at the end of the loop already asks the agent for an account of itself, using
 * the same one-tool mechanism. Firing a checkpoint just before that would pay for two nearly
 * identical turns and reset a context that is about to be abandoned anyway.
 */
export const CHECKPOINT_MIN_REMAINING = 0.15;

export interface CheckpointDecision {
  tokensUsed: number;
  maxTokens: number;
  /** How many have already fired this run. */
  taken: number;
}

/**
 * Whether this turn boundary should become a checkpoint.
 *
 * Tokens, not steps. sandbox-tools.ts settles that argument already — "a step is not a unit of
 * anything, it can be 200 tokens or 20,000" — and tokens are the direct proxy for the thing a
 * context reset treats: with the conversation pinned at CONVERSATION_CHAR_BUDGET, tokens spent is
 * roughly turns times context size, which is how long the agent has been reasoning inside a window
 * that is already full.
 *
 * Deliberately NOT `turnIndex % n`. The abandoned harness-v2 branch wrote exactly that, against a
 * threshold of the same n, so its turn condition could never fire — the bug is quiet because the
 * expression looks like it counts something.
 */
export function shouldCheckpoint(state: CheckpointDecision): boolean {
  const { tokensUsed, maxTokens, taken } = state;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return false;
  if (taken >= CHECKPOINTS) return false;
  if (maxTokens - tokensUsed < maxTokens * CHECKPOINT_MIN_REMAINING) return false;

  const slice = maxTokens / (CHECKPOINTS + 1);
  return tokensUsed >= slice * (taken + 1);
}

/**
 * What the agent contributes, and the only part of a checkpoint it is asked for.
 *
 * Three questions, none of which the harness can answer from the repository. The diff says which
 * files changed; it does not say which of them was the point, what was tried and abandoned, or what
 * the next phase should do first. That is the deliberative thread a reset would otherwise lose, and
 * it is exactly what a git summary cannot reconstruct.
 */
export const HANDOFF_TOOL = {
  type: 'function',
  function: {
    name: 'handoff',
    description:
      'Write down where this task stands, so work can resume from it. Called when the harness '
      + 'pauses you to save progress — not something you choose. Be specific and factual; this is '
      + 'read by whoever picks the task up next, which may be you with no memory of this session.',
    parameters: {
      type: 'object',
      properties: {
        done: {
          type: 'string',
          description: 'What is actually finished and working, as opposed to started. Be concrete.',
        },
        next: {
          type: 'string',
          description: 'The immediate next actions, in order. What should the next phase do first?',
        },
        learned: {
          type: 'string',
          description:
            'Anything discovered that is NOT visible in the diff — a command that does not work '
            + 'here, an approach that was tried and abandoned and why, a constraint found the hard '
            + 'way. Leave empty if there is nothing.',
        },
      },
      required: ['done', 'next'],
    },
  },
} as const;

export interface Handoff {
  done: string;
  next: string;
  learned?: string;
}

/** Bounded: this lands in a repository file and in the next attempt's prompt. */
const MAX_HANDOFF_FIELD = 2000;

export function parseHandoff(args: Record<string, unknown>): Handoff | undefined {
  const done = typeof args.done === 'string' ? args.done.trim() : '';
  const next = typeof args.next === 'string' ? args.next.trim() : '';
  if (!done && !next) return undefined;

  const learned = typeof args.learned === 'string' ? args.learned.trim() : '';
  return {
    done: done.slice(0, MAX_HANDOFF_FIELD) || '(not stated)',
    next: next.slice(0, MAX_HANDOFF_FIELD) || '(not stated)',
    ...(learned ? { learned: learned.slice(0, MAX_HANDOFF_FIELD) } : {}),
  };
}

export interface CheckpointArtifactParts {
  /** Which checkpoint this is, 1-based. */
  number: number;
  taskTitle: string;
  at: string;
  tokensUsed: number;
  maxTokens: number;
  /** The agent's own account. Absent when the forced turn failed or returned prose. */
  handoff?: Handoff | undefined;
  /** Present for a persona that works in a repository. */
  repo?: {
    branch: string;
    commits: string;
    changed: string;
  } | undefined;
  /** Present for a persona whose deliverable is a file rather than a checkout. */
  findings?: {
    path: string;
    outcome: VerifyOutcome;
    reason: string;
    chars: number;
  } | undefined;
  /** Whatever the verify command said at this boundary, when one ran. */
  verify?: { outcome: VerifyOutcome; output: string } | undefined;
  /** Declared artifacts still missing, if the leaf declared any. */
  missing?: string[] | undefined;
}

/** Kept small: the whole artifact is re-read into the next attempt's prompt. */
const MAX_SECTION_CHARS = 1500;

const clip = (s: string, n = MAX_SECTION_CHARS) =>
  (s.length > n ? `${s.slice(0, n)}\n…[trimmed]` : s);

/**
 * The artifact, assembled from what is checkable plus what the agent said.
 *
 * ── WHY THIS IS ASSEMBLED RATHER THAN SUMMARISED ──
 * A model could be asked to write the whole thing. It should not be, because most of what belongs
 * here is already a FACT the harness holds: which commits exist, which files changed, what the
 * verify command exited with, which declared artifacts are still missing. Asking a model to restate
 * those is asking it to re-derive, less accurately, something already known — and to do it at the
 * one moment its context is most degraded, which is why the checkpoint is firing.
 *
 * So the split is: the harness writes what it can check, the agent writes what only it knows, and
 * the two are clearly labelled so a reader can tell which is which.
 */
export function buildCheckpointArtifact(parts: CheckpointArtifactParts): string {
  const pct = parts.maxTokens > 0 ? Math.round((parts.tokensUsed / parts.maxTokens) * 100) : 0;

  const lines = [
    `# Checkpoint ${parts.number} — ${parts.taskTitle}`,
    '',
    `_Written by the harness at ${parts.at}, ${parts.tokensUsed.toLocaleString()} of `
    + `${parts.maxTokens.toLocaleString()} tokens (${pct}%)._`,
    '',
    'This file is a save point. The conversation that produced the work below was reset after it',
    'was written, so this — plus the repository itself — is what the next phase starts from.',
  ];

  if (parts.handoff) {
    lines.push(
      '',
      '## What the agent says is done',
      clip(parts.handoff.done),
      '',
      '## What it says comes next',
      clip(parts.handoff.next),
    );
    if (parts.handoff.learned) {
      lines.push(
        '',
        '## What it learned that is not in the diff',
        clip(parts.handoff.learned),
      );
    }
  } else {
    // Said rather than omitted: a missing section reads as "nothing to report", and the difference
    // between that and "we could not ask" matters to whoever reads this next.
    lines.push('', '## What the agent says', '_The handoff turn did not produce an answer._');
  }

  if (parts.repo) {
    lines.push(
      '',
      '## What is actually committed',
      `Branch: \`${parts.repo.branch}\``,
      '',
      '```',
      clip(parts.repo.commits || '(no commits yet)'),
      '```',
      '',
      '```',
      clip(parts.repo.changed || '(no files changed yet)'),
      '```',
    );
  }

  if (parts.findings) {
    lines.push(
      '',
      '## The deliverable so far',
      `\`${parts.findings.path}\` — ${parts.findings.chars.toLocaleString()} characters, `
      + `currently **${parts.findings.outcome}**.`,
      '',
      parts.findings.reason || '_No detail given._',
    );
  }

  if (parts.verify) {
    lines.push(
      '',
      `## Verification at this point: **${parts.verify.outcome}**`,
      ...(parts.verify.output.trim() ? ['', '```', clip(parts.verify.output, 800), '```'] : []),
    );
  }

  if (parts.missing?.length) {
    lines.push(
      '',
      '## Declared artifacts still missing',
      ...parts.missing.slice(0, 20).map((f) => `- \`${f}\``),
    );
  }

  return lines.join('\n');
}

/**
 * The message that replaces the conversation.
 *
 * A reset is not a silent truncation — the agent is told it happened and why, because an agent that
 * finds its own context inexplicably shorter will spend turns re-establishing things it already
 * knew. The artifact is quoted in full: it is the only thing carried across, so it has to be here
 * rather than referenced.
 */
export function assembleResetPrompt(taskTitle: string, artifact: string): string {
  // The caller passes the first line of the task context, which for a leaf is already
  // "Task: <title>" — so without this the prompt reads "You have been working on: Task: …".
  const title = taskTitle.replace(/^Task:\s*/i, '').trim() || 'this task';
  return [
    `You have been working on: ${title}`,
    '',
    'Your conversation history was reset to keep you inside the context window. Nothing you did was',
    'lost — it is committed, and it is summarised below. This is your save point.',
    '',
    '---',
    artifact,
    '---',
    '',
    'Resume from here. Start by checking the current state of the workspace rather than assuming it,',
    'then carry on with the next actions above. Do not redo work that is already committed.',
  ].join('\n');
}
