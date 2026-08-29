import type { VerifyOutcome } from './leaf-verify.js';

export const CHECKPOINTS = 2;

export const CHECKPOINT_MIN_REMAINING = 0.15;

export interface CheckpointDecision {
  tokensUsed: number;
  maxTokens: number;
  taken: number;
}

export function shouldCheckpoint(state: CheckpointDecision): boolean {
  const { tokensUsed, maxTokens, taken } = state;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return false;
  if (taken >= CHECKPOINTS) return false;
  if (maxTokens - tokensUsed < maxTokens * CHECKPOINT_MIN_REMAINING) return false;

  const slice = maxTokens / (CHECKPOINTS + 1);
  return tokensUsed >= slice * (taken + 1);
}

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
  number: number;
  taskTitle: string;
  at: string;
  tokensUsed: number;
  maxTokens: number;
  handoff?: Handoff | undefined;
  repo?: {
    branch: string;
    commits: string;
    changed: string;
  } | undefined;
  findings?: {
    path: string;
    outcome: VerifyOutcome;
    reason: string;
    chars: number;
  } | undefined;
  verify?: { outcome: VerifyOutcome; output: string } | undefined;
  missing?: string[] | undefined;
}

const MAX_SECTION_CHARS = 1500;

const clip = (s: string, n = MAX_SECTION_CHARS) =>
  (s.length > n ? `${s.slice(0, n)}\n…[trimmed]` : s);

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

export function assembleResetPrompt(taskTitle: string, artifact: string): string {
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
