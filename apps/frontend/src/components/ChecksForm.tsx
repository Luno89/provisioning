export default function ChecksForm({
  value, onChange, onSubmit, onCancel, saving = false, error, hint, placeholder, submitLabel = 'Save',
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  saving?: boolean;
  error?: string | null | undefined;
  hint?: string | undefined;
  placeholder?: string | undefined;
  submitLabel?: string;
}) {
  return (
    <div className="mb-2">
      {hint && <p className="text-[11px] text-slate-500 mb-1">{hint}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        aria-label="Commands"
        placeholder={placeholder}
        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-[12px] text-slate-200 font-mono resize-y focus:border-[var(--leaf)] focus:outline-none"
      />
      {error && <p className="mt-1 text-[11px] text-amber-400">{error}</p>}
      <div className="flex gap-2 mt-1.5">
        <button
          onClick={onSubmit}
          disabled={saving || !value.trim()}
          className="px-3 py-1 rounded-lg bg-[var(--leaf-stem)] text-white text-[11px] font-semibold disabled:opacity-40"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded-lg text-slate-400 hover:text-slate-200 text-[11px]">
          Cancel
        </button>
      </div>
    </div>
  );
}
