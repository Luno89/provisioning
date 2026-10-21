import { Loader2, Server } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { placeText, useFilePlace, useFileServers, usePlaceChange } from './shared'

export default function FilePlacePicker({ projectId, compact = false }: { projectId: string; compact?: boolean | undefined }) {
  const place = useFilePlace(projectId)
  const servers = useFileServers()
  const { choose, startMinio } = usePlaceChange(projectId)
  const state = place.data
  const listed = servers.data?.servers ?? []
  const current = state && state.state !== 'none' ? state.place.deploymentId : undefined
  const failure = choose.error ?? startMinio.error

  if (place.isPending) return <p className="text-[11px] text-slate-500"><Loader2 size={11} className="inline animate-spin" /> Reading where its files go…</p>

  return (
    <div className="space-y-2 text-[12px]" data-testid="file-place">
      <p className={state?.state === 'gone' ? 'text-red-300' : 'text-slate-300'}>
        <Server size={12} className="mr-1 inline text-sky-400" />
        Files that are not code: {placeText(state)}
        {state?.state === 'starting' && <Loader2 size={11} className="ml-1 inline animate-spin" />}
      </p>
      {!compact && <p className="text-[11px] text-slate-500">Code goes in the repository. Everything else dropped on Files (documents, images, spreadsheets, chat attachments) goes to this server, under the project&apos;s own folder. Changing the server later leaves what is already stored where it is.</p>}
      {state?.state !== 'starting' && (
        <div className="flex flex-wrap items-center gap-2">
          {listed.length > 0 && (
            <select
              aria-label="The project's file server"
              value={state?.state === 'ready' && state.chosen ? current : ''}
              onChange={(event) => { if (event.target.value) choose.mutate(event.target.value) }}
              disabled={choose.isPending}
              className="rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-[12px] text-slate-200"
            >
              <option value="">{state?.state === 'ready' && !state.chosen ? 'Your default' : 'Choose a file server…'}</option>
              {listed.map((server) => <option key={server.deploymentId} value={server.deploymentId}>{server.name}</option>)}
            </select>
          )}
          {(state?.state === 'none' || state?.state === 'gone') && (
            <button type="button" onClick={() => startMinio.mutate()} disabled={startMinio.isPending} className="rounded bg-[var(--leaf-stem)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
              {startMinio.isPending ? 'Starting…' : 'Start MinIO for this project'}
            </button>
          )}
        </div>
      )}
      {failure && <p role="alert" className="text-[11px] text-red-300">{errorMessage(failure)}</p>}
    </div>
  )
}
