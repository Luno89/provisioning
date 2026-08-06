/**
 * A text field that can be opened in a full editor.
 *
 * ── WHY ──
 * The values here are not all the same size. A verify command is a line; a system prompt is 1,600
 * characters and was being edited in a single-line input inside a table, which is unusable in the
 * literal sense — you cannot see what you are changing. Sizing every field for the largest one
 * would waste the layout on the common case, so the field stays small and grows on demand.
 *
 * ── THE EDITOR IS A TRANSACTION ──
 * It holds its own draft and commits on Save. This is the opposite of what the field does inline,
 * and the difference is the point: a stray keystroke in a one-line input is trivially undone, but
 * reworking a long prompt and then wanting the original back is not — and nothing else on the page
 * remembers it. Cancel is that memory. Save writes to the page's draft; persisting is still the
 * page's own Save, one deliberate act further on.
 *
 * ── WHERE IT OPENS ──
 * A view with somewhere sensible to put an editor claims it with `useEditorSlot` and renders
 * `EditorHost`; Focus gives it the left half, so the text you are editing sits beside the model
 * output that prompted the edit instead of covering it. Views with no such space — the cards, the
 * new-experiment form — get an overlay, which is the same panel with a backdrop behind it.
 */
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
  /** Shown as the editor's heading, so an expanded field still says what it is. */
  label: string;
  placeholder?: string;
  /** Inline height. 1 renders a single-line input, which is what a table row wants. */
  rows?: number;
  field: string;
  disabled?: boolean;
  /** Overrides the guess made from the label. */
  language?: Language;
  /**
   * What the editor opens with when the field is empty — the value in force rather than nothing.
   *
   * The inline field stays empty on purpose: empty means "inherit", and that distinction is what
   * keeps a variant from freezing every default it never touched. But it makes the editor useless
   * for the case it exists for, since tuning the 1,600-character system prompt starts by reading
   * it. So the editor prepopulates and the field does not; committing is what makes it an override.
   */
  fallback?: string;
  /** Where a prepopulated value came from, named in the editor so forking a default is visible. */
  fallbackNote?: string;
  /**
   * False for values with nothing to expand into — a temperature is one number, and offering to
   * open it full screen suggests there is more of it to see. Driven by the registry's declared
   * type, so it stays true of a knob nobody has thought about yet.
   */
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
            // The right padding only exists to clear the button, so it goes with it.
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

/** The editor in a claimed slot. Keyed by field, so moving between fields starts a fresh draft. */
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
  /** Set when the text was inherited rather than typed here — named so forking it is deliberate. */
  origin?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const dirty = draft !== initial;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Stopped from propagating: Focus also closes on Escape, and one keypress should not both
      // abandon the edit AND leave the screen.
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
          // The knob is not set on this variant: what is loaded is the value in force, and saving
          // is what turns it into an override. Said here because the editor otherwise looks the
          // same either way.
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
        {/* Both steps named, since Save here does not reach the server and that is worth knowing. */}
        Save applies the edit to the page · saving the page writes it · ⌘↵ saves, Esc cancels
      </p>
    </div>
  );
}
