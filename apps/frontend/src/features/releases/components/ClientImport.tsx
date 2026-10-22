import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Upload } from 'lucide-react'
import { clientImportKeys, startFresh, uploadImport, type ClientImport as Imported, type ImportMode, type ImportView } from '../api/client-import'
import { errorMessage } from '../../../api/client'

const what = (entry: Imported) =>
  `Odoo ${entry.version ?? '?'}, ${entry.modules?.length ?? 0} modules, ${entry.mode === 'copy' ? 'as a copy to work on' : 'as the client\'s live system'}`

function Status({ entry }: { entry: Imported }) {
  switch (entry.state) {
    case 'awaited':
      return <p className="text-amber-300">This project starts from the client&apos;s database: its first release waits for their backup.</p>
    case 'uploading':
      return <p className="text-slate-300">Uploading the backup…</p>
    case 'uploaded':
      return <p className="text-slate-300">Uploaded ({what(entry)}). The project&apos;s first build restores it into slot a; if there is no build yet, it waits for one.</p>
    case 'importing':
      return <p className="flex items-center gap-1.5 text-slate-300"><Loader2 size={11} className="animate-spin" />Restoring it into slot a ({what(entry)}).</p>
    case 'imported':
      return <p className="text-emerald-300">Started from the client&apos;s database ({what(entry)}). What was made in their app is listed below, under Made in the live app.</p>
    case 'refused':
    case 'failed':
      return (
        <div className="space-y-1">
          <p className="text-rose-400">{entry.state === 'refused' ? 'Refused' : 'It failed'}: {entry.reason}</p>
          {entry.missing && entry.missing.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {entry.missing.map((name) => <li key={name} className="rounded bg-[var(--bark-800)] px-1.5 py-0.5 font-mono text-[11px] text-slate-200">{name}</li>)}
            </ul>
          )}
        </div>
      )
  }
}

export function ClientImport({ projectId, view }: { projectId: string; view: ImportView }) {
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<ImportMode>('copy')
  const [progress, setProgress] = useState(0)
  const queryClient = useQueryClient()
  const upload = useMutation({
    mutationFn: (chosen: File) => uploadImport(projectId, chosen, mode, setProgress),
    onSettled: () => queryClient.invalidateQueries({ queryKey: clientImportKeys.view(projectId) }),
  })

  const fresh = useMutation({
    mutationFn: () => startFresh(projectId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: clientImportKeys.view(projectId) }),
  })
  const setAside = view.open && view.import && ['awaited', 'uploaded', 'refused', 'failed'].includes(view.import.state)

  return (
    <div className="space-y-3" data-testid="client-import">
      {view.import && <Status entry={view.import} />}
      {view.open ? (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-400">
            The backup Odoo&apos;s database manager makes (Backup, as a zip with its files), from the same Odoo version as this project.
            It becomes slot a when the project first releases, and Koala&apos;s sign-in takes over its admin user.
          </p>
          <input type="file" accept=".zip,application/zip" aria-label="The client's backup" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="block text-[11px] text-slate-300" />
          <fieldset className="space-y-1">
            <label className="flex items-start gap-2 text-slate-200">
              <input type="radio" name="import-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} className="mt-0.5" />
              <span>A copy to work on <span className="text-slate-500">(its outgoing mail, scheduled jobs and payments are switched off)</span></span>
            </label>
            <label className="flex items-start gap-2 text-slate-200">
              <input type="radio" name="import-mode" checked={mode === 'live'} onChange={() => setMode('live')} className="mt-0.5" />
              <span>The client&apos;s live system <span className="text-slate-500">(mail and scheduled jobs run from here)</span></span>
            </label>
          </fieldset>
          <button
            type="button"
            onClick={() => file && upload.mutate(file)}
            disabled={!file || upload.isPending}
            className="flex items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {upload.isPending ? `Uploading ${Math.round(progress * 100)}%` : 'Start from this backup'}
          </button>
          {upload.isError && <p className="text-[11px] text-rose-400">{errorMessage(upload.error)}</p>}
          {setAside && (
            <div className="border-t border-[var(--bark-700)] pt-2">
              <button
                type="button"
                onClick={() => fresh.mutate()}
                disabled={fresh.isPending}
                className="rounded border border-[var(--bark-600)] px-2.5 py-1 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50"
              >
                Start without their database
              </button>
              <p className="mt-1 text-[11px] text-slate-500">Releases the project&apos;s own starter instead; the client&apos;s database can no longer be brought in once it is live.</p>
              {fresh.isError && <p className="text-[11px] text-rose-400">{errorMessage(fresh.error)}</p>}
            </div>
          )}
        </div>
      ) : (
        !view.import && view.why && <p className="text-[11px] text-slate-400">{view.why}</p>
      )}
    </div>
  )
}
