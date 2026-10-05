import { useQuery } from '@tanstack/react-query';
import { X, Loader2, FileText } from 'lucide-react';
import Markdown from './Markdown.js';
import { documentKeys, readDocument } from '../api/documents';
import { errorMessage } from '../api/client';
import type { DocumentAddress } from '../types/documents';

const useDocument = (address: DocumentAddress) => useQuery({
  queryKey: documentKeys.one(address),
  queryFn: () => readDocument(address),
  retry: false,
});

export function DocumentPanel({ file, onClose }: { file: DocumentAddress; onClose: () => void }) {
  const { data, isPending, isError, error } = useDocument(file);
  const markdown = file.path.endsWith('.md');

  return (
    <aside
      aria-label={`Document ${file.path}`}
      className="fixed top-0 right-0 z-40 h-full w-full sm:w-[38rem] max-w-full flex flex-col bg-[var(--bark-950,#090d0b)] border-l border-[var(--bark-800,#1b2620)] shadow-2xl font-sans"
    >
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[var(--bark-800,#1b2620)]">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm text-slate-100 font-mono truncate">
            <FileText size={14} className="shrink-0 text-emerald-400" />
            <span className="truncate">{file.path}</span>
          </div>
          {data && (
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
              in {data.owner}/{data.repo}{data.ref === 'main' ? '' : ` at ${data.ref.slice(0, 12)}`}
              {file.at && data.ref === 'main' && ' — its commit is gone, so this is main'}
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close document" className="text-slate-400 hover:text-slate-100 shrink-0">
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm text-slate-200">
        {isPending && (
          <div className="flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin" /> Opening…</div>
        )}
        {isError && <div className="text-red-300">{errorMessage(error)}</div>}
        {data && (markdown
          ? <Markdown>{data.content}</Markdown>
          : <pre className="whitespace-pre-wrap font-mono text-[12px] text-slate-300">{data.content}</pre>)}
      </div>
    </aside>
  );
}

export default DocumentPanel;
