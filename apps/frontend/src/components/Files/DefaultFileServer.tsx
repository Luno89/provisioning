import { Link } from '@tanstack/react-router'
import { errorMessage } from '../../api/client'
import { useFileServers, useSetDefaultFileServer } from './shared'

const panel = 'mt-6 rounded-3xl border border-white/5 bg-slate-900/40 p-6'

export default function DefaultFileServer() {
  const servers = useFileServers()
  const setDefault = useSetDefaultFileServer()
  const listed = servers.data?.servers ?? []

  return (
    <div className={panel} data-testid="default-file-server">
      <h4 className="mb-1 text-lg font-bold text-white">Files</h4>
      <p className="text-xs text-slate-400">
        Files that are not code (documents, images, chat attachments) are kept on your own file server, MinIO or Nextcloud.
        Each project can choose its own in its Settings; any project that has not, and anything you attach outside a project, uses this one.
      </p>
      {servers.isPending ? null : listed.length === 0 ? (
        <p className="mt-3 text-xs text-slate-400">
          You have no file server running yet. <Link to="/infrastructure/$tab" params={{ tab: 'apps' }} className="text-sky-300 underline">Deploy MinIO or Nextcloud</Link>, or start MinIO from a project&apos;s Settings.
        </p>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
          Your default
          <select
            aria-label="Your default file server"
            value={servers.data?.defaultId ?? ''}
            onChange={(event) => setDefault.mutate(event.target.value || null)}
            disabled={setDefault.isPending}
            className="rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">None</option>
            {listed.map((server) => <option key={server.deploymentId} value={server.deploymentId}>{server.name} ({server.kind === 'minio' ? 'MinIO' : 'Nextcloud'})</option>)}
          </select>
        </label>
      )}
      {setDefault.isError && <p role="alert" className="mt-2 text-xs text-red-300">{errorMessage(setDefault.error)}</p>}
    </div>
  )
}
