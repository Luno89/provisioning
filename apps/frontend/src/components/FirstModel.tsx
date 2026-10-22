import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { defaultModelKeys, getDefaultModel, listModels, providerKeys, setDefaultModel, type ModelProvider } from '../api/models'
import { openRouterConnectUrl } from '../features/infrastructure'
import { errorMessage } from '../api/client'
import { firstModelChoices, firstModelStep } from '../lib/first-model'
import { formatIntelligence, formatPrice } from '../lib/model-groups'
import { useLocalAgentDevices } from '../api/local-agents'
import { machineRows, type MachineRow } from '../lib/machine-rows'

const LATER_KEY = 'koala.firstModel.later'

function laterChosen(): boolean {
  try { return sessionStorage.getItem(LATER_KEY) === '1' } catch { return false }
}

function chooseLater(): void {
  try { sessionStorage.setItem(LATER_KEY, '1') } catch { return }
}

const primary = 'inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-500'
const quiet = 'inline-flex items-center gap-1.5 rounded-xl bg-slate-700 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-600'

function Choice({ model, picking, onPick }: { model: ModelProvider; picking: boolean; onPick: (id: string) => void }) {
  const price = formatPrice(model)
  const strength = formatIntelligence(model)
  return (
    <li>
      <button type="button" disabled={picking} onClick={() => onPick(model.id)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-700 px-3 py-2 text-left text-sm hover:border-emerald-500 disabled:opacity-50">
        <span className="min-w-0 truncate">{model.model}</span>
        <span className="flex shrink-0 gap-2 text-[11px] text-slate-400">
          {strength && <span>{strength}</span>}
          {price && <span className={price === 'free' ? 'text-emerald-300' : 'text-amber-300'}>{price === 'free' ? 'free' : `${price} per million tokens`}</span>}
        </span>
      </button>
    </li>
  )
}

function MachineChoice({ row, picking, onPick }: { row: MachineRow; picking: boolean; onPick: (id: string) => void }) {
  return (
    <li>
      <button type="button" disabled={picking} onClick={() => onPick(row.id)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-700 px-3 py-2 text-left text-sm hover:border-emerald-500 disabled:opacity-50">
        <span className="min-w-0 truncate">{row.agentTitle}</span>
        <span className="shrink-0 text-[11px] text-slate-400">on {row.deviceName}</span>
      </button>
    </li>
  )
}

function Way({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 rounded-xl border border-slate-700 p-3">
      <h3 className="text-sm font-bold text-slate-100">{title}</h3>
      {children}
    </section>
  )
}

export function FirstModel() {
  const queryClient = useQueryClient()
  const [later, setLater] = useState(laterChosen)
  const models = useQuery({ queryKey: providerKeys.list(), queryFn: listModels })
  const setting = useQuery({ queryKey: defaultModelKeys.current(), queryFn: getDefaultModel })
  const devices = useLocalAgentDevices()
  const pick = useMutation({
    mutationFn: (id: string) => setDefaultModel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: defaultModelKeys.current() }),
  })

  if (later || !models.data || !setting.data) return null
  const rows = machineRows(devices.data ?? [])
  const step = firstModelStep(models.data, setting.data.defaultModelId, rows)
  if (step === 'none') return null
  const { yours, machines, free, paid } = firstModelChoices(models.data, rows)
  const putOff = () => { chooseLater(); setLater(true) }

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Give Koala a model">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4 text-slate-100">
        <h2 className="text-lg font-bold">Give Koala a model to think with</h2>
        {step === 'connect' ? (
          <>
            <p className="text-sm text-slate-300">Koala needs a language model before it can do anything. There are three ways to give it one.</p>
            <Way title="OpenRouter, the quickest">
              <p className="text-xs text-slate-400">You sign in there, it makes a key on your own account, and Koala uses it. Many of its models are free; anything that costs money is billed to you by OpenRouter, and Koala never picks one for you.</p>
              <a href={openRouterConnectUrl()} className={primary}>Connect OpenRouter</a>
            </Way>
            <Way title="A model on your own machine">
              <p className="text-xs text-slate-400">Join your machine (a GPU helps) under Infrastructure → Your own hardware with one command, make it a cluster, and deploy TabbyAPI or vLLM there with a model. Nothing leaves your machine, and it shows here once it answers.</p>
              <a href="#/infrastructure/hardware" className={quiet} onClick={putOff}>Add my machine</a>
            </Way>
            <Way title="A subscription you already have">
              <p className="text-xs text-slate-400">Claude Code, Codex or Gemini CLI, signed in on your machine with your own plan. Add the machine under My Machines with one command; once its agent is ready you pick it here. Chats and the agents that can hand their work to a machine run on it; anything that cannot (checks, the bench) still needs a model.</p>
              <a href="#/mesh" className={quiet} onClick={putOff}>Add my machine</a>
            </Way>
            <a href="#/studio/models" className="text-xs text-slate-400 underline hover:text-slate-200" onClick={putOff}>Or paste a key for any OpenAI-compatible provider</a>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300">Pick the model Koala and its agents use unless you choose another for a chat or an agent. You can change it any time in Studio → Models.</p>
            {pick.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(pick.error)}</div>}
            {machines.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">On your machines</h3>
                <p className="text-[11px] text-slate-500">Chats and the agents that can hand their work to a machine run on it; checks and the bench still need a model.</p>
                <ul className="space-y-1">{machines.map((row) => <MachineChoice key={row.id} row={row} picking={pick.isPending} onPick={(id) => pick.mutate(id)} />)}</ul>
              </section>
            )}
            {yours.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">On your own servers</h3>
                <ul className="space-y-1">{yours.map((model) => <Choice key={model.id} model={model} picking={pick.isPending} onPick={(id) => pick.mutate(id)} />)}</ul>
              </section>
            )}
            {free.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Free</h3>
                <ul className="space-y-1">{free.map((model) => <Choice key={model.id} model={model} picking={pick.isPending} onPick={(id) => pick.mutate(id)} />)}</ul>
              </section>
            )}
            {paid.length > 0 && (
              <details className="space-y-2">
                <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-slate-400">Paid, billed by their provider ({paid.length})</summary>
                <ul className="mt-2 space-y-1">{paid.map((model) => <Choice key={model.id} model={model} picking={pick.isPending} onPick={(id) => pick.mutate(id)} />)}</ul>
              </details>
            )}
            {pick.isPending && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> Saving…</div>}
          </>
        )}
        <button type="button" className="text-xs text-slate-500 hover:text-slate-300" onClick={putOff}>Later</button>
      </div>
    </div>
  )
}
