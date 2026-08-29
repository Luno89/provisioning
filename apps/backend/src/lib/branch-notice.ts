import { trimTranscript, type Branch, type BranchMessage } from './leaves.js';
import type { AcceptanceCheck } from './acceptance.js';

export interface Notice {
  text: string;
}

const MAX_NOTICE_CHARS = 700;

export function buildFailureNotice(
  title: string,
  error: string,
  attemptsSpent: number,
  attemptsAllowed: number,
): Notice {
  const exhausted = attemptsSpent >= attemptsAllowed;
  return {
    text: [
      exhausted
        ? `**"${title}" failed and will not be retried** (${attemptsSpent}/${attemptsAllowed} attempts).`
        : `**"${title}" failed** (attempt ${attemptsSpent} of ${attemptsAllowed}) and will retry.`,
      '',
      error.trim().slice(0, MAX_NOTICE_CHARS),
      ...(exhausted
        ? ['', 'Anything waiting on it cannot start. Propose a replacement, or say what should change.']
        : []),
    ].join('\n'),
  };
}

export function buildAcceptanceNotice(
  plan: AcceptanceCheck[],
  failed?: { name: string; output: string } | undefined,
): Notice {
  if (!failed) {
    return {
      text: [
        '**The work is done and every acceptance check passes.**',
        '',
        ...plan.map((c) => `- ✅ ${c.name} — \`${c.command}\``),
      ].join('\n'),
    };
  }

  const at = plan.findIndex((c) => c.name === failed.name);
  return {
    text: [
      `**Every leaf finished, but the acceptance check "${failed.name}" fails.**`,
      '',
      ...plan.map((c, i) => {
        const mark = i < at ? '✅' : i === at ? '❌' : '⏭️';
        return `- ${mark} ${c.name} — \`${c.command}\``;
      }),
      '',
      failed.output.trim().slice(0, MAX_NOTICE_CHARS) || '(no output)',
      '',
      'The parts each passed their own checks; assembled they do not. Something needs to change.',
    ].join('\n'),
  };
}

export function withNotice(branch: Branch, notice: Notice, now = new Date().toISOString()): Branch {
  const message: BranchMessage = { role: 'assistant', content: notice.text, notice: true };
  return { ...branch, messages: trimTranscript([...branch.messages, message]), updatedAt: now };
}
