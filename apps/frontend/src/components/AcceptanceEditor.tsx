import { useState } from 'react';
import ChecksForm from './ChecksForm.js';
import { errorMessage } from '../api/client';

export type Check = string | { name: string; command: string };

const commandOf = (check: Check) => (typeof check === 'string' ? check : check.command);

export default function AcceptanceEditor({ checks, onSave }: {
  checks: Check[];
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
        <p className="text-[11px] text-amber-400/90 mb-1.5">
          No checks yet — nothing would verify this request, so its work cannot be accepted.
        </p>
      )}
      <button
        onClick={() => { setDraft(checks.map(commandOf).join('\n')); setError(null); }}
        className="mt-1 text-[11px] text-[var(--leaf)] hover:underline"
      >
        {checks.length ? 'Edit checks' : 'Set checks'}
      </button>
    </>
  );
}
