import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, FileCode2, Loader2 } from 'lucide-react'
import { releaseFiles, releaseKeys, type ReleaseFile } from '../api/releases'
import { errorMessage } from '../../../api/client'

const STATUS: Record<ReleaseFile['status'], { mark: string; tone: string }> = {
  added: { mark: 'A', tone: 'text-emerald-300' },
  modified: { mark: 'M', tone: 'text-amber-300' },
  deleted: { mark: 'D', tone: 'text-rose-300' },
  renamed: { mark: 'R', tone: 'text-sky-300' },
}

function lineTone(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return 'text-slate-500'
  if (line.startsWith('+')) return 'text-emerald-300 bg-emerald-500/10'
  if (line.startsWith('-')) return 'text-rose-300 bg-rose-500/10'
  if (line.startsWith('@@')) return 'text-sky-300'
  return 'text-slate-400'
}

function FileRow({ file }: { file: ReleaseFile }) {
  const [open, setOpen] = useState(false)
  return (
    <li data-testid="release-file">
      <button type="button" onClick={() => setOpen((was) => !was)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-[var(--bark-800)]">
        {open ? <ChevronDown size={11} className="shrink-0 text-slate-500" /> : <ChevronRight size={11} className="shrink-0 text-slate-500" />}
        <span className={`w-3 shrink-0 font-bold ${STATUS[file.status].tone}`}>{STATUS[file.status].mark}</span>
        <span className="min-w-0 flex-1 truncate text-slate-200" title={file.from ? `${file.from} → ${file.path}` : file.path}>
          {file.from ? `${file.from} → ` : ''}{file.path}
        </span>
        {file.binary
          ? <span className="shrink-0 text-slate-500">binary</span>
          : <span className="shrink-0"><span className="text-emerald-400">+{file.added}</span> <span className="text-rose-400">−{file.removed}</span></span>}
      </button>
      {open && (
        <pre className="mt-1 max-h-96 overflow-auto rounded border border-[var(--bark-800)] bg-[var(--bark-950)] py-1 text-[10.5px] leading-snug" data-testid="release-file-patch">
          {file.patch.split('\n').map((line, at) => <div key={at} className={`px-2 whitespace-pre ${lineTone(line)}`}>{line || ' '}</div>)}
        </pre>
      )}
    </li>
  )
}

function Group({ title, hint, files }: { title: string; hint: string; files: ReleaseFile[] }) {
  if (files.length === 0) return null
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] text-slate-300">{title} <span className="text-slate-500">· {hint}</span></p>
      <ul>{files.map((file) => <FileRow key={file.path} file={file} />)}</ul>
    </div>
  )
}

export function ReleaseFiles({ projectId, releaseId }: { projectId: string; releaseId: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: releaseKeys.files(projectId, releaseId), queryFn: () => releaseFiles(projectId, releaseId) })

  return (
    <div className="space-y-1.5" data-testid="release-files">
      <h5 className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
        <FileCode2 size={11} /> Files changed
        {data?.against && <span className="normal-case tracking-normal font-normal">since {data.against.commit.slice(0, 8)} ({data.against.state === 'live' ? 'live now' : 'the release it replaced'})</span>}
      </h5>
      {isLoading && <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><Loader2 size={11} className="animate-spin" /> Reading what changed…</p>}
      {error && <p className="text-[11px] text-rose-400">{errorMessage(error)}</p>}
      {data?.note && <p className="text-[11px] text-slate-500">{data.note}</p>}
      {data && !data.note && data.files.length === 0 && <p className="text-[11px] text-slate-500">No file differs.</p>}
      {data && (
        <>
          <Group title="In the app" hint="built into the new image" files={data.files.filter((file) => file.inApp)} />
          <Group title="Elsewhere in the repository" hint="not part of the app, so they change nothing that runs" files={data.files.filter((file) => !file.inApp)} />
        </>
      )}
    </div>
  )
}
