import { useContext, useEffect, useId, useState } from 'react';
import { Maximize2, X, Check } from 'lucide-react';
import { CodeEditor } from './CodeEditor';
import { EditorSlot, languageFor, type EditRequest, type Language } from './shared';

export function ExpandableText({
  value, onChange, label, placeholder, rows = 3, field, disabled, language, fallback, fallbackNote,
  expandable = true,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  field: string;
  disabled?: boolean;
  language?: Language;
  fallback?: string;
  fallbackNote?: string;
  expandable?: boolean;
}) {
  const slot = useContext(EditorSlot);
  const id = useId();
  const [overlay, setOverlay] = useState(false);
  const opening = value || fallback || '';
  const inherited = !value && !!fallback;
  const request: EditRequest = {
    id, label, value: opening, language: language ?? languageFor(label), onChange,
    ...(inherited && fallbackNote ? { origin: fallbackNote } : {}),
  };
  const editing = slot?.openId === id;

  return (
    <>
      <div className="relative">
        {rows === 1 ? (
          <input
            className={expandable ? `${field} pr-7` : field}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <textarea
            className={`${expandable ? `${field} pr-7` : field} resize-y`}
            style={{ height: `${rows * 1.5}rem` }}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {expandable && (
          <button
            onClick={() => (slot ? slot.open(request) : setOverlay(true))}
            title={`Edit ${label} in the full editor`}
            className={`absolute top-1 right-1 p-0.5 ${
              editing ? 'text-[var(--leaf-light)]' : 'text-slate-600 hover:text-slate-300'
            }`}
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>

      {overlay && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-8">
          <div className="w-full max-w-4xl h-full">
            <EditorPanel
              label={label}
              initial={opening}
              language={request.language}
              {...(inherited && fallbackNote ? { origin: fallbackNote } : {})}
              onSave={(v) => { onChange(v); setOverlay(false); }}
              onCancel={() => setOverlay(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

export function EditorHost({
  request, onClose,
}: {
  request: EditRequest;
  onClose: () => void;
}) {
  return (
    <EditorPanel
      key={request.id}
      label={request.label}
      initial={request.value}
      language={request.language}
      {...(request.origin ? { origin: request.origin } : {})}
      onSave={(v) => { request.onChange(v); onClose(); }}
      onCancel={onClose}
    />
  );
}

function EditorPanel({
  label, initial, language, origin, onSave, onCancel,
}: {
  label: string;
  initial: string;
  language: Language;
  origin?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const dirty = draft !== initial;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.stopPropagation(); onSave(draft); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft, onCancel, onSave]);

  return (
    <div className="h-full flex flex-col bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--bark-600)] shrink-0">
        <span className="text-[12px] font-semibold text-slate-200 truncate">{label}</span>
        <span className="text-[10px] text-slate-600 whitespace-nowrap">
          {draft.length} chars{dirty ? ' · modified' : ''}
        </span>
        {origin && (
          <span className="text-[10px] text-amber-400/80 truncate">
            loaded from the {origin} — saving overrides it
          </span>
        )}
        <button
          onClick={() => onSave(draft)}
          disabled={!dirty}
          className="ml-auto flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-30"
        >
          <Check size={11} /> Save
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded text-slate-500 hover:text-slate-200"
        >
          <X size={11} /> Cancel
        </button>
      </div>

      <CodeEditor
        value={draft}
        onChange={setDraft}
        language={language}
        label={label}
        autoFocus
        className="flex-1 min-h-0 border-0 rounded-none"
      />

      <p className="px-3 py-1.5 text-[10px] text-slate-600 border-t border-[var(--bark-600)] shrink-0">
        Save applies the edit to the page · saving the page writes it · ⌘↵ saves, Esc cancels
      </p>
    </div>
  );
}
