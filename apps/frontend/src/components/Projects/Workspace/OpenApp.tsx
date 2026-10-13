import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Globe, Monitor } from 'lucide-react'
import { getProjectApp, openProjectApp, projectAppKeys, type ExposureMode } from '../../../api/project-app.js'
import { releaseKeys } from '../../../api/releases.js'
import { errorMessage } from '../../../api/client.js'

const hostOf = (address: string): string => {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}

export function OpenApp({ projectId, which = 'app' }: { projectId: string; which?: 'app' | 'preview' | undefined }) {
  const qc = useQueryClient()
  const [menu, setMenu] = useState(false)
  const app = useQuery({ queryKey: projectAppKeys.of(projectId), queryFn: () => getProjectApp(projectId) })
  const open = useMutation({
    mutationFn: ({ mode }: { mode: ExposureMode; tab: Window | null }) => openProjectApp(projectId, mode),
    onSuccess: (opened, { mode, tab }) => {
      qc.setQueryData(projectAppKeys.of(projectId), opened)
      void qc.invalidateQueries({ queryKey: releaseKeys.list(projectId) })
      const address = opened[mode][which]
      if (tab && address) tab.location.href = address
      else tab?.close()
    },
    onError: (_err, { tab }) => { tab?.close() },
  })

  const current = app.data
  if (!current || current.status !== 'running') return null

  const choose = (mode: ExposureMode) => {
    setMenu(false)
    const known = current[mode][which]
    if (known) {
      window.open(known, '_blank', 'noopener,noreferrer')
      return
    }
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    open.mutate({ mode, tab })
  }

  const label = which === 'preview' ? 'Open preview' : 'Open app'
  const option = (mode: ExposureMode, Icon: typeof Monitor, title: string, says: string) => {
    const known = current[mode][which]
    return (
      <button type="button" role="menuitem" onClick={() => choose(mode)} className="w-full text-left px-2.5 py-2 hover:bg-[var(--bark-700)] cursor-pointer flex gap-2">
        <Icon size={13} className="mt-0.5 shrink-0 text-slate-400" />
        <span>
          <span className="block text-slate-200">{known ? title : `Expose ${title.toLowerCase()} and open`}</span>
          <span className="block text-[10px] text-slate-500 break-all">{known ? hostOf(known) : says}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((shown) => !shown)}
        disabled={open.isPending}
        className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[11px] font-medium px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
      >
        <ExternalLink size={11} /> {open.isPending ? 'Exposing…' : label} <ChevronDown size={11} />
      </button>
      {menu && (
        <div role="menu" className="absolute z-20 mt-1 w-52 rounded-md border border-[var(--bark-600)] bg-[var(--bark-800)] text-[11px] shadow-lg">
          {option('local', Monitor, 'On this machine', 'Reachable only from this computer.')}
          {option('public', Globe, 'Publicly', 'Anyone with the address can reach it, from anywhere.')}
        </div>
      )}
      {open.isError && <p className="mt-1 text-[11px] text-rose-300">{errorMessage(open.error)}</p>}
    </div>
  )
}
