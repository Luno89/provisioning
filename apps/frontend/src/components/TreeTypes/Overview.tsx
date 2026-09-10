import { field, label, SLUG_PATTERN, type TreeType, type WorkspaceLanguage } from './shared.js';

const LANGUAGES: WorkspaceLanguage[] = ['node', 'python', 'go', 'base'];

export function Overview({ value, onChange, idEditable, idError }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
  /** True only for a not-yet-saved draft — id is the URL param for every other type, so it's fixed once created. */
  idEditable?: boolean;
  idError?: string | undefined;
}) {
  return (
    <div className="space-y-4">
      {idEditable && (
        <div>
          <label className={label}>Id (slug — lowercase letters, numbers, single hyphens)</label>
          <input
            className={field}
            value={value.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder="my-new-type"
          />
          {value.id && !SLUG_PATTERN.test(value.id) && (
            <p className="text-[11px] text-red-400 mt-1">Not a valid slug.</p>
          )}
          {idError && <p className="text-[11px] text-red-400 mt-1">{idError}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Label</label>
          <input className={field} value={value.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="My new type" />
        </div>
        <div>
          <label className={label}>Produces</label>
          <select className={field} value={value.produces} onChange={(e) => onChange({ produces: e.target.value as TreeType['produces'] })}>
            <option value="service">service — deployed and reachable</option>
            <option value="artefact">artefact — a document or file, not deployed</option>
          </select>
        </div>
      </div>

      <div>
        <label className={label}>Summary</label>
        <input className={field} value={value.summary} onChange={(e) => onChange({ summary: e.target.value })} placeholder="One line describing what this produces" />
      </div>

      <div>
        <label className={label}>Done means</label>
        <textarea
          className={`${field} min-h-20`}
          value={value.doneMeans}
          onChange={(e) => onChange({ doneMeans: e.target.value })}
        />
        <p className="text-[11px] text-slate-500 mt-1">What acceptance for a leaf of this type starts from.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Language / workspace image</label>
          <select className={field} value={value.language} onChange={(e) => onChange({ language: e.target.value as WorkspaceLanguage })}>
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Duplicate threshold</label>
          <input
            className={field} type="number" min={0} max={1} step={0.05}
            value={value.duplicateThreshold ?? ''}
            placeholder="Default"
            onChange={(e) => onChange({ duplicateThreshold: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
          />
          <p className="text-[11px] text-slate-500 mt-1">0–1 similarity above which two leaves get flagged as possible duplicates.</p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-slate-300">
        <input type="checkbox" checked={value.requireSources ?? false} onChange={(e) => onChange({ requireSources: e.target.checked || undefined })} />
        Output must cite sources (checked for document-producing types)
      </label>
    </div>
  );
}

export default Overview;
