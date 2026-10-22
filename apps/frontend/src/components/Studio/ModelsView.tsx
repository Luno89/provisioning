import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Trash2, X } from 'lucide-react'
import { deleteLlmCredentials, listLlmProviders, openRouterConnectUrl, saveLlmCredentials, type LlmProviderStatus } from '../../features/infrastructure'
import { errorMessage } from '../../api/client'
import { LLM_PROVIDERS } from '../../features/infrastructure'
import { openRouterNoticeFrom, withoutOpenRouterNotice } from '../../lib/openrouter-notice'
import { DefaultModelPicker } from './DefaultModelPicker'

const LLM_KEYS = ['credentials', 'llm'] as const

const input = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2.5 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'
const primary = 'rounded-md bg-[var(--leaf-stem)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90'
const quiet = 'rounded-md border border-[var(--bark-600)] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-[var(--bark-700)] disabled:opacity-50'

function ProviderCard({ provider, status }: { provider: (typeof LLM_PROVIDERS)[number]; status: LlmProviderStatus | undefined }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const refresh = () => qc.invalidateQueries({ queryKey: LLM_KEYS })
  const save = useMutation({
    mutationFn: () => saveLlmCredentials({ provider: provider.key, ...form }),
    onSuccess: () => { void refresh(); setEditing(false); setForm({}) },
  })
  const remove = useMutation({
    mutationFn: () => deleteLlmCredentials(provider.key),
    onSuccess: () => { void refresh(); setConfirming(false) },
  })
  const models = status?.modelCount ?? 0
  const connected = models > 0 || Boolean(status?.hasKey)
  const failed = save.error ?? remove.error

  return (
    <li className={`space-y-2 rounded-md border bg-[var(--bark-900)]/40 p-3 ${editing ? 'md:col-span-2' : ''} ${connected ? 'border-[var(--bark-600)]' : 'border-[var(--bark-700)]'}`} data-testid="model-provider">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md text-lg" style={{ backgroundColor: `${provider.color}15`, color: provider.color }}>{provider.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-100">
            {provider.label}
            {provider.docsUrl && <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300" aria-label={`Get a ${provider.label} key`}><ExternalLink size={12} /></a>}
          </div>
          <div className={`text-[11px] ${connected ? 'text-emerald-300' : 'text-slate-500'}`}>{connected ? `${models} model${models === 1 ? '' : 's'} connected` : 'Not connected'}</div>
        </div>
        {!editing && !confirming && (
          <div className="flex gap-1.5">
            {provider.connectsWithAccount && <a href={openRouterConnectUrl()} className={connected ? quiet : primary}>{connected ? 'Reconnect' : `Connect ${provider.label}`}</a>}
            <button type="button" className={quiet} onClick={() => { setEditing(true); setForm({}) }}>{connected ? 'Change key' : provider.connectsWithAccount ? 'Paste a key' : 'Connect'}</button>
            {connected && <button type="button" className={`${quiet} text-rose-300`} onClick={() => setConfirming(true)} aria-label={`Remove ${provider.label}`}><Trash2 size={12} /></button>}
          </div>
        )}
      </div>

      {provider.connectsWithAccount && !connected && !editing && (
        <p className="text-[11px] text-slate-400">Sign in to {provider.label} and approve, and Koala gets a key on your own account. Free models cost nothing; anything else is billed by {provider.label}, and nothing paid is picked for you.</p>
      )}

      {editing && (
        <form
          className="space-y-2"
          onSubmit={(event) => { event.preventDefault(); save.mutate() }}
        >
          {provider.fields.map((field) => (
            <label key={field.key} className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{field.label}</span>
              <input
                type={field.sensitive ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={form[field.key] ?? ''}
                onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                className={input}
              />
            </label>
          ))}
          <div className="flex justify-end gap-1.5">
            <button type="button" className={quiet} onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" disabled={save.isPending} className="flex items-center gap-1 rounded-md bg-[var(--leaf-stem)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50">
              {save.isPending && <Loader2 size={11} className="animate-spin" />} Connect and fetch models
            </button>
          </div>
        </form>
      )}

      {confirming && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-slate-300">Remove {provider.label}? Its models leave your list, and anything set to one of them needs another.</span>
          <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()} className="rounded-md bg-rose-600 px-2 py-1 font-semibold text-white disabled:opacity-50">{remove.isPending ? <Loader2 size={11} className="animate-spin" /> : 'Remove it'}</button>
          <button type="button" className={quiet} onClick={() => setConfirming(false)}>Keep it</button>
        </div>
      )}

      {failed && <p className="flex items-center gap-1.5 text-[11px] text-rose-300"><AlertTriangle size={12} /> {errorMessage(failed)}</p>}
    </li>
  )
}

export default function ModelsView() {
  const providers = useQuery({ queryKey: LLM_KEYS, queryFn: listLlmProviders })
  const [notice, setNotice] = useState(() => openRouterNoticeFrom(window.location.search))

  useEffect(() => {
    if (openRouterNoticeFrom(window.location.search)) window.history.replaceState(null, '', `${window.location.pathname}${withoutOpenRouterNotice(window.location.search)}${window.location.hash}`)
  }, [])

  return (
    <div className="max-w-4xl space-y-8">
      <p className="max-w-2xl text-sm text-slate-400">
        The models your agents can run on: the ones your own servers serve (a TabbyAPI or vLLM app you deploy shows up by itself), and any provider you connect below.
      </p>

      <section className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-4">
        <DefaultModelPicker />
      </section>

      <section className="space-y-2" id="model-providers">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Providers</h3>
        {notice && (
          <p role="status" className={`flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-[12px] ${notice.kind === 'success' ? 'border-emerald-700/60 text-emerald-300' : 'border-rose-700/60 text-rose-300'}`}>
            {notice.kind === 'success' ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
            <span className="flex-1">{notice.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-slate-500 hover:text-slate-300"><X size={12} /></button>
          </p>
        )}
        {providers.isPending && <p className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={12} className="animate-spin" /> Reading your providers…</p>}
        {providers.isError && <p className="text-[12px] text-rose-300">{errorMessage(providers.error)}</p>}
        {providers.data && (
          <ul className="grid gap-2 md:grid-cols-2">
            {LLM_PROVIDERS.map((provider) => <ProviderCard key={provider.key} provider={provider} status={providers.data.find((status) => status.provider === provider.key)} />)}
          </ul>
        )}
      </section>
    </div>
  )
}
