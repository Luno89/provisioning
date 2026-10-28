import { ExternalLink, Trash2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { shareUrl } from '../api/files'
import { expiresText } from '../lib/file-browser'
import { useFileShares, useRevokeShare } from '../shared'

export default function FileShares() {
  const shares = useFileShares()
  const revoke = useRevokeShare()
  if (shares.isPending) return null
  if (!shares.data?.length) return <p className="text-xs text-slate-500">No file is shared by a link.</p>
  const now = new Date()
  return (
    <ul className="space-y-1" data-testid="file-shares">
      {shares.data.map((share) => (
        <li key={share.id} className="flex items-center gap-2 text-xs text-slate-300">
          <a href={shareUrl(share.token, window.location.origin)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 truncate text-sky-300 hover:underline" title={share.path}>
            <ExternalLink size={11} className="shrink-0" /> {share.name}
          </a>
          <span className="shrink-0 text-slate-500">{expiresText(share.expiresAt, now)}</span>
          <button type="button" aria-label={`Stop sharing ${share.name}`} onClick={() => revoke.mutate(share.id)} disabled={revoke.isPending} className="ml-auto shrink-0 rounded p-0.5 text-slate-500 hover:text-red-300"><Trash2 size={11} /></button>
        </li>
      ))}
      {revoke.isError && <li role="alert" className="text-red-300">{errorMessage(revoke.error)}</li>}
    </ul>
  )
}
