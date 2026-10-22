import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Loader2 } from 'lucide-react'
import { getTreeModels, groveKeys, setTreeModel, type TreeModelRow } from '../../../api/grove'
import { listModels, providerKeys, type ModelProvider } from '../../../api/models'
import { useMachineChoiceLabel } from '../../../api/local-agents'
import { errorMessage } from '../../../api/client'
import { modelOptionLabel } from '../../../lib/model-label'
import { useShellStore } from '../../../features/platform'
import { ModelPicker } from '../../ModelPicker'
import { wholeTreeChanges } from '../Strip/shared'

const nameOf = (models: readonly ModelProvider[], id: string): string => {
  const found = models.find((model) => model.id === id)
  return found ? modelOptionLabel(found) : id
}

function ownText(row: TreeModelRow, models: readonly ModelProvider[]): string {
  if ('machine' in row.own) return 'Always runs on its machine (set in the Studio)'
  if ('problem' in row.own) return `Its own: none it can use — ${row.own.problem}`
  return `Its own: ${nameOf(models, row.own.modelId)}`
}

function Row({ treeId, row, models }: { treeId: string; row: TreeModelRow; models: ModelProvider[] }) {
  const qc = useQueryClient()
  const setView = useShellStore((s) => s.setView)
  const [choosing, setChoosing] = useState(false)
  const save = useMutation({
    mutationFn: (modelId: string | null) => setTreeModel(treeId, row.agent, modelId),
    onSuccess: (rows) => {
      qc.setQueryData(groveKeys.models(treeId), rows)
      setChoosing(false)
    },
  })
  const fixed = 'machine' in row.own
  const own = ownText(row, models)
  const machine = useMachineChoiceLabel(row.chosen?.modelId)
  const chosenName = row.chosen ? machine ?? nameOf(models, row.chosen.modelId) : undefined

  return (
    <li className="flex flex-col gap-1" data-testid="tree-model-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-slate-200 font-semibold">{row.name}</div>
          {row.describe && <div className="text-[11px] text-slate-500">{row.describe}</div>}
        </div>
        {!fixed && (
          <button
            type="button"
            onClick={() => setChoosing(!choosing)}
            className="shrink-0 px-2 py-0.5 rounded border border-[var(--bark-600)] hover:bg-[var(--bark-700)] text-slate-200 cursor-pointer"
          >
            {choosing ? 'Close' : 'Change'}
          </button>
        )}
      </div>
      {row.chosen
        ? row.chosen.gone
          ? <span className="text-amber-400">{machine ? `${machine} can no longer do this work` : `${row.chosen.modelId} is no longer among your models`}, so its runs will fail until you choose another.</span>
          : <span><span className="font-mono text-emerald-300">{chosenName}</span> <span className="text-slate-500">chosen for this tree</span></span>
        : <span className="text-slate-400">{own}</span>}
      {choosing && (
        <ModelPicker
          models={models}
          selectedId={row.chosen?.modelId ?? null}
          onSelect={(id) => save.mutate(id)}
          inheritOption={{ label: fixed || 'problem' in row.own ? 'Its own' : own, onSelect: () => save.mutate(null) }}
          onConfigure={() => setView('studio', ['models'])}
          {...(row.noMachine ? {} : { machines: { onManage: () => setView('mesh') } })}
          autoFocus
        />
      )}
      {choosing && row.noMachine && (
        <span className="text-[11px] text-slate-500">{row.name}'s procedure has no way to hand its work to a machine, so only your models are offered.</span>
      )}
      {save.isPending && <span className="flex items-center gap-1 text-slate-500"><Loader2 size={11} className="animate-spin" /> Saving…</span>}
      {save.error && <span className="text-red-400">{errorMessage(save.error) || 'The choice was not saved.'}</span>}
    </li>
  )
}

function EveryAgent({ treeId, rows, models }: { treeId: string; rows: TreeModelRow[]; models: ModelProvider[] }) {
  const qc = useQueryClient()
  const setView = useShellStore((s) => s.setView)
  const [choosing, setChoosing] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])
  const save = useMutation({
    mutationFn: async (modelId: string | null) => {
      const { changes, skipped: left } = wholeTreeChanges(rows, modelId)
      let latest = rows
      for (const change of changes) latest = await setTreeModel(treeId, change.agent, change.modelId)
      return { latest, left }
    },
    onSuccess: ({ latest, left }) => {
      qc.setQueryData(groveKeys.models(treeId), latest)
      setSkipped(left)
      setChoosing(false)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: groveKeys.models(treeId) }),
  })
  const anyChosen = rows.some((row) => row.chosen)

  return (
    <li className="flex flex-col gap-1 pb-2 border-b border-[var(--bark-800)]" data-testid="tree-model-every">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-slate-200 font-semibold">Every agent in this tree</div>
          <div className="text-[11px] text-slate-500">Put them all on one model or machine at once, or back on their own.</div>
        </div>
        <button
          type="button"
          onClick={() => setChoosing(!choosing)}
          className="shrink-0 px-2 py-0.5 rounded border border-[var(--bark-600)] hover:bg-[var(--bark-700)] text-slate-200 cursor-pointer"
        >
          {choosing ? 'Close' : 'Choose'}
        </button>
      </div>
      {choosing && (
        <ModelPicker
          models={models}
          selectedId={null}
          onSelect={(id) => save.mutate(id)}
          {...(anyChosen ? { inheritOption: { label: 'Each on its own again', onSelect: () => save.mutate(null) } } : {})}
          onConfigure={() => setView('studio', ['models'])}
          machines={{ onManage: () => setView('mesh') }}
          autoFocus
        />
      )}
      {skipped.length > 0 && <span className="text-[11px] text-slate-500">{skipped.join(', ')} cannot hand work to a machine, so {skipped.length === 1 ? 'it stays' : 'they stay'} as before.</span>}
      {save.isPending && <span className="flex items-center gap-1 text-slate-500"><Loader2 size={11} className="animate-spin" /> Saving…</span>}
      {save.error && <span className="text-red-400">{errorMessage(save.error) || 'The choice was not saved.'}</span>}
    </li>
  )
}

export function TreeModels({ treeId }: { treeId: string }) {
  const rows = useQuery({ queryKey: groveKeys.models(treeId), queryFn: () => getTreeModels(treeId) })
  const models = useQuery({ queryKey: providerKeys.list(), queryFn: listModels })

  if (rows.error) return <p className="text-red-400">Could not read the tree's models: {errorMessage(rows.error)}</p>
  if (!rows.data) return null

  return (
    <section className="flex flex-col gap-2 border-t border-[var(--bark-800)] pt-2" data-testid="tree-models">
      <div className="flex items-center gap-1.5 text-slate-200 font-semibold">
        <Cpu size={12} className="text-emerald-400" /> Models
      </div>
      <p className="text-[11px] text-slate-500">Which model each agent works on in this tree, or which agent on one of your machines. A choice here is for this tree only; the rest use the agent's own. An agent on a machine works in a checkout of the tree's work there, runs its checks back in the tree's workspace, and is judged like any other.</p>
      {rows.data.length === 0
        ? <p className="text-slate-500">Nothing in this tree's work asks a model.</p>
        : (
          <ul className="flex flex-col gap-3">
            {rows.data.filter((row) => !('machine' in row.own)).length > 1 && <EveryAgent treeId={treeId} rows={rows.data} models={models.data ?? []} />}
            {rows.data.map((row) => <Row key={row.agent} treeId={treeId} row={row} models={models.data ?? []} />)}
          </ul>
        )}
    </section>
  )
}
