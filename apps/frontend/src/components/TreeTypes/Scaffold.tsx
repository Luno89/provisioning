import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { card, field, label, type TreeType, type TreeTypeFile } from './shared.js';

const blankFile = (): TreeTypeFile => ({ path: '', content: '' });

export function Scaffold({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const files = value.files;

  const patchFile = (index: number, patch: Partial<TreeTypeFile>) =>
    onChange({ files: files.map((f, i) => (i === index ? { ...f, ...patch } : f)) });

  const removeFile = (index: number) => onChange({ files: files.filter((_, i) => i !== index) });

  const addFile = () => {
    onChange({ files: [...files, blankFile()] });
    setOpen(files.length);
  };

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        Starter files rendered into a fresh repository when a tree of this type is created.
        <code className="mx-1 text-[11px]">{'{{projectName}}'}</code>
        and
        <code className="mx-1 text-[11px]">{'{{registryHost}}'}</code>
        are substituted in both path and content. At most 20 files.
      </p>

      <div className="space-y-2">
        {files.length === 0 && <p className="text-[12px] text-slate-500 italic">No starter files.</p>}

        {files.map((f, i) => (
          <div key={i} className={card}>
            <div className="w-full flex items-center gap-2 px-3 py-2">
              <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                {open === i ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <ChevronRight size={14} className="text-slate-500 shrink-0" />}
                <span className="font-mono text-[12px] text-slate-200 truncate">{f.path || '(no path yet)'}</span>
                {f.executable && <span className="text-[10px] text-slate-500 shrink-0">executable</span>}
              </button>
              <button type="button" title="Remove" onClick={() => removeFile(i)} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer">
                <Trash2 size={14} />
              </button>
            </div>

            {open === i && (
              <div className="px-3 pb-3 border-t border-[var(--bark-700)] pt-3 space-y-2">
                <div>
                  <label className={label}>Path</label>
                  <input className={`${field} font-mono`} value={f.path} onChange={(e) => patchFile(i, { path: e.target.value })} />
                </div>
                <div>
                  <label className={label}>Content</label>
                  <textarea
                    className={`${field} font-mono min-h-40`}
                    value={f.content}
                    onChange={(e) => patchFile(i, { content: e.target.value })}
                  />
                </div>
                <label className="flex items-center gap-2 text-[12px] text-slate-300">
                  <input type="checkbox" checked={f.executable ?? false} onChange={(e) => patchFile(i, { executable: e.target.checked || undefined })} />
                  Executable
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        disabled={files.length >= 20}
        onClick={addFile}
        className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-30 text-white cursor-pointer disabled:cursor-not-allowed"
      >
        <Plus size={13} /> Add file
      </button>
    </div>
  );
}

export default Scaffold;
