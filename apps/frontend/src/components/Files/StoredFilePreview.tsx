import { useQuery } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { fileKeys, readStoredText, storedFileUrl } from '../../api/files'
import { previewKind } from '../../lib/file-browser'
import type { FileScope } from '../../types/files'
import ShareFile from './ShareFile'

const TEXT_LIMIT = 200_000

function TextPreview({ scope, path }: { scope: FileScope; path: string }) {
  const text = useQuery({ queryKey: [...fileKeys.all, 'text', scope.kind === 'mine' ? 'mine' : `${scope.kind}:${scope.projectId}`, path], queryFn: () => readStoredText(scope, path) })
  if (text.isPending) return <p className="p-3 text-[12px] text-slate-500">Reading…</p>
  if (text.isError) return <p className="p-3 text-[12px] text-red-300">It could not be read.</p>
  const shown = text.data.length > TEXT_LIMIT ? `${text.data.slice(0, TEXT_LIMIT)}\n…` : text.data
  return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] text-slate-200">{shown}</pre>
}

export default function StoredFilePreview({ scope, path, onClose }: { scope: FileScope; path: string; onClose?: (() => void) | undefined }) {
  const name = path.split('/').pop() ?? path
  const url = storedFileUrl(scope, path, true)
  const kind = previewKind(name)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="stored-file-preview">
      <div className="flex items-center gap-2 border-b border-[var(--bark-700)] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300" title={path}>{path}</span>
        <a href={storedFileUrl(scope, path)} aria-label={`Download ${name}`} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100"><Download size={11} /> Download</a>
        {onClose && <button type="button" aria-label="Close the preview" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100"><X size={13} /></button>}
      </div>
      {scope.kind !== 'hub' && <div className="border-b border-[var(--bark-700)] px-3 py-2"><ShareFile scope={scope} path={path} /></div>}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto bg-[var(--bark-950)]">
        {kind === 'image' && <img src={url} alt={name} className="max-h-full max-w-full object-contain" />}
        {kind === 'pdf' && <iframe src={url} title={name} className="h-full min-h-[480px] w-full border-0 bg-white" />}
        {kind === 'video' && <video src={url} controls className="max-h-full max-w-full" />}
        {kind === 'audio' && <audio src={url} controls className="w-full max-w-md" />}
        {kind === 'text' && <div className="flex min-h-0 w-full flex-1"><TextPreview scope={scope} path={path} /></div>}
        {kind === 'none' && <p className="p-6 text-[12px] text-slate-500">This kind of file has no preview here; download it to open it.</p>}
      </div>
    </div>
  )
}
