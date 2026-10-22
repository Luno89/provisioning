import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { GitPullRequestArrow, Loader2 } from 'lucide-react'
import { customizationKeys, getDrift, proposeAdoption, type DriftItem } from '../api/customizations'
import { errorMessage } from '../../../api/client'

const KIND_LABELS: Record<string, string> = {
  field: 'field', model: 'model', view: 'view', 'edited-view': 'edited view', 'server-action': 'server action',
  automation: 'automation', report: 'report', 'email-template': 'email template',
}

const refOf = (item: DriftItem) => `${item.kind}/${item.key}`

export function LiveCustomizations({ projectId }: { projectId: string }) {
  const drift = useQuery({ queryKey: customizationKeys.drift(projectId), queryFn: () => getDrift(projectId) })
  const [left, setLeft] = useState<Set<string>>(new Set())
  const propose = useMutation({
    mutationFn: (refs: string[]) => proposeAdoption(projectId, refs, 'Keep what was made in the live app: bring it into git so every release keeps it.'),
  })

  if (drift.error) return <p className="text-[12px] text-rose-400">{errorMessage(drift.error)}</p>
  if (!drift.data) return <p className="text-[12px] text-slate-500">Reading the live app…</p>
  const { items, module } = drift.data
  if (items.length === 0) return <p className="text-[12px] text-slate-400">Nothing was made or changed in the live app that is not in git.</p>
  const chosen = items.filter((item) => !left.has(refOf(item))).map(refOf)

  return (
    <div className="space-y-2" data-testid="live-customizations">
      <p className="text-[11px] text-slate-400">
        The live app holds these, made or changed in the app and not in git. A release that changes what they rest on can reset or lose them.
        Bringing them in puts exact copies in <span className="font-mono">addons/{module}</span>, and every release keeps them.
      </p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={refOf(item)}>
            <label className="flex items-start gap-2 text-[12px] text-slate-200">
              <input
                type="checkbox"
                checked={!left.has(refOf(item))}
                onChange={() => setLeft((prev) => { const next = new Set(prev); if (next.has(refOf(item))) next.delete(refOf(item)); else next.add(refOf(item)); return next })}
                className="mt-0.5"
              />
              <span>{item.name.replace(/,$/, '')} <span className="text-slate-500">({KIND_LABELS[item.kind] ?? item.kind})</span></span>
            </label>
          </li>
        ))}
      </ul>
      {propose.isSuccess ? (
        <p className="text-[11px] text-emerald-300">It waits for you on a card in the project&apos;s channel: approving it adds the story that brings them in, and runs the tree.</p>
      ) : (
        <button
          type="button"
          onClick={() => propose.mutate(chosen)}
          disabled={propose.isPending || chosen.length === 0}
          className="flex items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {propose.isPending ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequestArrow size={11} />}
          Bring {chosen.length === items.length ? 'them all' : `${chosen.length}`} into git
        </button>
      )}
      {propose.isError && <p className="text-[11px] text-rose-400">{errorMessage(propose.error)}</p>}
    </div>
  )
}
