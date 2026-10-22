import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { hubKeys, listHubRepository, readHubRepositoryFile } from '../../api/hub'

export default function HubRepository({ projectId }: { projectId: string }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const files = useQuery({ queryKey: hubKeys.repository(projectId), queryFn: () => listHubRepository(projectId), retry: false })
  const file = useQuery({
    queryKey: hubKeys.repositoryFile(projectId, path ?? ''),
    queryFn: () => readHubRepositoryFile(projectId, path!),
    enabled: path !== undefined,
    retry: false,
  })
  return (
    <section className="space-y-2" data-testid="hub-repository">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Repository</h2>
      {files.isPending && <p className="text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Reading the repository…</p>}
      {files.isError && <p role="alert" className="text-[12px] text-red-300">{errorMessage(files.error)}</p>}
      {files.data && files.data.files.length === 0 && <p className="text-[12px] italic text-slate-500">The repository has no files yet.</p>}
      {files.data && files.data.files.length > 0 && (
        <div className="grid gap-3 md:grid-cols-[18rem_1fr]">
          <ul className="max-h-96 overflow-y-auto rounded-md border border-[var(--bark-700)] py-1 text-[12px]">
            {files.data.files.map((name) => {
              const depth = name.split('/').length - 1
              return (
                <li key={name}>
                  <button type="button" onClick={() => setPath(name)} style={{ paddingLeft: 8 + depth * 12 }} className={`flex w-full items-center gap-1.5 truncate py-0.5 pr-2 text-left hover:bg-[var(--bark-700)] ${path === name ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300'}`}>
                    <FileText size={11} className="shrink-0 text-slate-500" /> <span className="truncate">{name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="min-w-0">
            {path === undefined && <p className="text-[12px] italic text-slate-500">Pick a file to read it. This is a read-only copy; changes are made on the owner's instance.</p>}
            {file.isPending && path !== undefined && <p className="text-[12px] text-slate-500">Opening {path}…</p>}
            {file.isError && <p role="alert" className="text-[12px] text-red-300">{errorMessage(file.error)}</p>}
            {file.data && <pre aria-label={file.data.path} className="max-h-96 overflow-auto rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] p-2 text-[11px] text-slate-200">{file.data.content}</pre>}
          </div>
        </div>
      )}
    </section>
  )
}
