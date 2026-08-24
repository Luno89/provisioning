import { useState } from 'react';
import ChecksForm from './ChecksForm.js';
import { errorMessage } from '../api/client';

/**
 * Changing the acceptance plan for a branch.
 *
 * ── WHY THIS EXISTS ──
 * Nothing on a branch may be accepted until something would check the finished result. That rule is
 * worth keeping — without it a run reports success on pieces never assembled and tried — but the
 * plan was only ever set by the planner calling `set_acceptance` during planning. A follow-up branch
 * had none, could accept nothing, and offered no way to fix it.
 *
 * A new branch now inherits its tree's plan. This is the way out when that inherited nothing, or
 * inherited the wrong thing.
 *
 * ── WHAT IT OWNS, AND WHAT IT DOES NOT ──
 * It owns the policy: what a check has to do, and what to say when the server refuses one. The form
 * beneath it owns only the shape of the input, and the plan DISPLAY is a sibling the caller
 * composes — this renders no list of its own, so there is one component responsible for showing a
 * plan rather than two that can disagree.
 */

/** A stored check. The API also accepts a bare command string, which older branches contain. */
export type Check = string | { name: string; command: string };

const commandOf = (check: Check) => (typeof check === 'string' ? check : check.command);

export default function AcceptanceEditor({ checks, onSave }: {
  checks: Check[];
  /** Rejects with the server's reason when a check cannot fail. */
  onSave: (commands: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const commands = (draft ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!commands.length) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(commands);
      setDraft(null);
    } catch (err: unknown) {
      /**
       * The server refuses a check that cannot fail — `echo ok` satisfies the accept gate and proves
       * nothing, and it does not matter who typed it. That reason is the useful half of the refusal,
       * so it is shown rather than replaced with "could not save".
       */
      // `errorMessage` from api/client is the one reader of a server error — this was a fourth
      // hand-rolled copy of the same `response.data.error ?? message` chain, and the only thing
      // holding it together was `any`.
      setError(errorMessage(err) || 'Could not save those checks.');
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <ChecksForm
        value={draft}
        onChange={setDraft}
        onSubmit={() => void save()}
        onCancel={() => setDraft(null)}
        saving={saving}
        error={error}
        submitLabel="Save checks"
        hint="One command per line. Each must exit non-zero when that part is broken, or it proves nothing."
        placeholder={'npm ci && npm test\nnode src/cli.js "Fall City, WA"'}
      />
    );
  }

  return (
    <>
      {checks.length === 0 && (
        /* The dead end, named. Nothing on this branch can be accepted until there is a plan, and
           before this nothing on screen said so — the accept button simply did nothing. */
        <p className="text-[11px] text-amber-400/90 mb-1.5">
          No checks yet — nothing would verify this request, so its work cannot be accepted.
        </p>
      )}
      {/* Seeded with what is there, so editing is a correction rather than a retype. */}
      <button
        onClick={() => { setDraft(checks.map(commandOf).join('\n')); setError(null); }}
        className="mt-1 text-[11px] text-[var(--leaf)] hover:underline"
      >
        {checks.length ? 'Edit checks' : 'Set checks'}
      </button>
    </>
  );
}
