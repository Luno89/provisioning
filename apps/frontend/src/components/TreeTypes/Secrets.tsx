import { Plus, Trash2 } from 'lucide-react';
import { card, field, label, type TreeType, type TreeTypeSecret, type TreeTypeSecretSource } from './shared.js';

const SOURCES: { id: TreeTypeSecretSource; says: string }[] = [
  { id: 'generated', says: 'The platform makes a random one' },
  { id: 'gitea-read-token', says: 'The platform mints a read-only Gitea token' },
  { id: 'person', says: 'The person enters it on a card' },
];

export function Secrets({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const secrets = value.secrets ?? [];
  const change = (at: number, patch: Partial<TreeTypeSecret>) => {
    onChange({ secrets: secrets.map((secret, i) => {
      if (i !== at) return secret;
      const next = { ...secret, ...patch };
      if (next.signInAs === '') delete next.signInAs;
      return next;
    }) });
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        Put in the project&apos;s vault when a tree of this type gets its project, and synced to the app as environment variables. No model ever sees a value.
      </p>
      {secrets.map((secret, i) => (
        <div key={i} className={`${card} p-3 space-y-2`} data-testid="tree-type-secret">
          <div className="flex items-center gap-2">
            <input
              className={`${field} font-mono w-64`} placeholder="ENV_NAME" aria-label="Key" value={secret.key}
              onChange={(e) => change(i, { key: e.target.value.toUpperCase() })}
            />
            <select className={`${field} w-auto`} aria-label="Comes from" value={secret.source} onChange={(e) => change(i, { source: e.target.value as TreeTypeSecretSource })}>
              {SOURCES.map((source) => <option key={source.id} value={source.id}>{source.says}</option>)}
            </select>
            <button type="button" aria-label={`Remove ${secret.key || 'secret'}`} onClick={() => onChange({ secrets: secrets.filter((_, j) => j !== i) })} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer">
              <Trash2 size={14} />
            </button>
          </div>
          <input
            className={field} placeholder="What it is for, and where the person finds it" aria-label="What it is for" value={secret.describe}
            onChange={(e) => change(i, { describe: e.target.value })}
          />
          <label className="block">
            <span className={label}>Signs in as (optional)</span>
            <input
              className={`${field} max-w-xs`} placeholder="admin" aria-label="Signs in as" value={secret.signInAs ?? ''}
              onChange={(e) => change(i, { signInAs: e.target.value })}
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ secrets: [...secrets, { key: '', source: 'generated', describe: '' }] })}
        className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
      >
        <Plus size={13} /> Add secret
      </button>
    </div>
  );
}
