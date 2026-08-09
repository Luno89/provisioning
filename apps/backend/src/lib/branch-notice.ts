/**
 * Telling the conversation what the work actually did.
 *
 * ── WHY THIS EXISTS ──
 * Nothing wrote to a branch when a leaf failed. The transcript ended wherever the planning stopped,
 * and everything after that — three attempts, 91,818 tokens, a permanently stranded dependent —
 * happened somewhere the user was not looking and the model could not see.
 *
 * Both consequences matter. The user finds out by noticing a coloured dot on a card, if they think
 * to look. And the next planning turn is blind to it: asked "how is it going", the model reports on
 * a board it last saw before any of the work ran, so a person has to go and read the failure out of
 * the API and paste it back in. Every round of that during a real end-to-end run was me doing a job
 * the system should do.
 *
 * ── WHY THESE ARE ASSISTANT MESSAGES ──
 * `BranchMessage` has two roles and neither is "the system". Assistant is the least wrong: it
 * renders as Koala reporting, which is what it is, and the next turn reads it as context it already
 * knows rather than as an instruction from the user. `notice` marks the provenance so the UI can
 * style it and nobody has to infer it from the wording.
 */
import { trimTranscript, type Branch, type BranchMessage } from './leaves.js';

export interface Notice {
  text: string;
}

/** Kept short. This lands in every future prompt on the branch, so it is a headline, not a report. */
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
        // Said explicitly, because the dependents will otherwise sit `pending` looking like work
        // that simply has not started.
        ? ['', 'Anything waiting on it cannot start. Propose a replacement, or say what should change.']
        : []),
    ].join('\n'),
  };
}

export function buildAcceptanceNotice(command: string, passed: boolean, output: string): Notice {
  return {
    text: [
      passed
        ? `**The work is done and the acceptance check passes.**`
        : `**Every leaf finished, but the acceptance check fails.**`,
      '',
      `\`${command}\``,
      '',
      output.trim().slice(0, MAX_NOTICE_CHARS) || '(no output)',
      ...(passed
        ? []
        // The failure this whole idea exists for: individually green leaves, an assembled thing
        // that does not work.
        : ['', 'The parts each passed their own checks; assembled they do not. Something needs to change.']),
    ].join('\n'),
  };
}

/**
 * Appends a notice, without letting a burst of them evict the conversation.
 *
 * `trimTranscript` is the same cap the chat route applies, so a branch cannot grow past what a turn
 * can carry — a ten-leaf plan that fails ten times must not push the original request out of its
 * own transcript.
 */
export function withNotice(branch: Branch, notice: Notice, now = new Date().toISOString()): Branch {
  const message: BranchMessage = { role: 'assistant', content: notice.text, notice: true };
  return { ...branch, messages: trimTranscript([...branch.messages, message]), updatedAt: now };
}
