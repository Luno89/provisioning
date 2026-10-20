import { useEffect, useState } from 'react'
import { Check, Cloud, Copy, HardDrive, Loader2, LogOut, RotateCcw } from 'lucide-react'
import { useCreateJoinCommand, useInstanceReady, useMySetup, useNameCheck, usePoolOffer, useStartPoolInstance, type InstanceStatus, type MySetup } from '../api/instances'
import { errorMessage } from '../api/client'

export interface NoInstanceProps {
  hasInstance: boolean
  onLogout: () => void
}

const STEPS: { status: InstanceStatus; label: string }[] = [
  { status: 'waiting', label: 'Waiting for your machine to run the command' },
  { status: 'joined', label: 'Your machine joined the mesh' },
  { status: 'installing', label: 'Installing your instance' },
  { status: 'ready', label: 'Ready' },
]

const POOL_STEPS: { status: InstanceStatus; label: string }[] = [
  { status: 'installing', label: 'Setting up your instance on Koala\'s servers' },
  { status: 'ready', label: 'Ready' },
]

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

function PoolProgress({ setup, retrying, onRetry }: { setup: MySetup; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-300">Your instance runs on Koala's servers until {setup.trialEndsAt ? day(setup.trialEndsAt) : 'the trial ends'}. Before then you can move it to your own machine, keeping all your work.</p>
      <ol className="space-y-1">
        {POOL_STEPS.map((step) => {
          const reached = setup.status === 'ready' || step.status === 'installing'
          const current = step.status === setup.status
          return (
            <li key={step.status} className={`flex items-center gap-2 text-xs ${reached ? 'text-slate-200' : 'text-slate-500'}`}>
              {current && setup.status !== 'ready' ? <Loader2 size={12} className="animate-spin" /> : <span className={`h-2 w-2 rounded-full ${reached ? 'bg-emerald-400' : 'bg-slate-600'}`} />}
              {step.label}
            </li>
          )
        })}
      </ol>
      {setup.status === 'failed' ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-rose-300">{setup.detail ?? 'Setting it up stopped.'}</p>
          <button type="button" onClick={onRetry} disabled={retrying} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--bark-700)] px-2 py-1 text-xs text-slate-200 disabled:opacity-50">
            {retrying ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Try again
          </button>
        </div>
      ) : setup.detail ? <p className="text-[11px] text-slate-400">{setup.detail}</p> : null}
    </div>
  )
}

export default function NoInstance({ hasInstance, onLogout }: NoInstanceProps) {
  const [copied, setCopied] = useState(false)
  const create = useCreateJoinCommand()
  const offer = usePoolOffer()
  const startPool = useStartPoolInstance()
  const settingUp = Boolean(create.data)
  const setup = useMySetup(settingUp)
  const ready = useInstanceReady()
  const status = setup.data?.status
  const fixedName = setup.data?.name
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const suggestion = useNameCheck('')
  const name = fixedName ?? typed ?? suggestion.data?.suggestion ?? ''
  const check = useNameCheck(name)
  const nameOk = Boolean(name) && (check.data?.ok ?? false)
  const inPool = Boolean(setup.data?.trialEndsAt) && !create.data

  useEffect(() => {
    if (status === 'ready') ready()
  }, [status, ready])

  const copy = async () => {
    if (!create.data) return
    await navigator.clipboard.writeText(create.data.command)
    setCopied(true)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-8">
        {hasInstance ? (
          <p className="flex items-center justify-center gap-2 text-sm text-slate-300"><Loader2 size={16} className="animate-spin" /> Taking you to your instance…</p>
        ) : (
          <>
            <p className="text-sm font-semibold">You don't have an instance yet</p>
            <p className="text-xs leading-relaxed text-slate-400">Your work runs on an instance of your own, on a machine you choose. Nothing about it is visible to anyone else.</p>
            {inPool && setup.data ? (
              <PoolProgress setup={setup.data} retrying={startPool.isPending} onRetry={() => startPool.mutate(setup.data!.name ?? name)} />
            ) : null}
            {!create.data && !inPool && (
              <div className="space-y-1">
                <label className="block text-xs text-slate-300" htmlFor="instance-name">Your name, in your instance's address</label>
                {fixedName ? (
                  <p className="font-mono text-xs text-slate-200">{fixedName}</p>
                ) : (
                  <input
                    id="instance-name"
                    value={name}
                    onChange={(event) => setTyped(event.target.value.toLowerCase())}
                    autoComplete="off"
                    className="w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 font-mono text-xs text-slate-100"
                  />
                )}
                {check.data?.problem ? (
                  <p role="alert" className="text-[11px] text-rose-300">{check.data.problem}</p>
                ) : check.data?.address ? (
                  <p className="text-[11px] text-slate-400">Your instance will be at <span className="font-mono text-slate-200">{check.data.address}</span>. A name stays as it is, since links use it.</p>
                ) : null}
              </div>
            )}
            {inPool ? null : !create.data ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {offer.data?.available && (
                    <button
                      type="button"
                      onClick={() => startPool.mutate(name)}
                      disabled={startPool.isPending || !nameOk}
                      className="inline-flex items-center gap-2 rounded-md bg-[var(--leaf-stem)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {startPool.isPending ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />} Try it on Koala's servers
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => create.mutate(name)}
                    disabled={create.isPending || !nameOk}
                    className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${offer.data?.available ? 'border border-[var(--bark-700)] text-slate-200' : 'bg-[var(--leaf-stem)] text-white'}`}
                  >
                    {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />} Use my own machine
                  </button>
                </div>
                {offer.data?.available && offer.data.trialDays ? (
                  <p className="text-[11px] text-slate-400">Koala's servers are free for {offer.data.trialDays} days, then your instance moves to a machine of your own, keeping all your work.</p>
                ) : offer.data?.reason && offer.data.trialDays ? (
                  <p className="text-[11px] text-slate-400">{offer.data.reason}.</p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-300">On the Linux machine you want to use, run this. It checks what the machine needs and asks before installing anything.</p>
                <div className="flex items-start gap-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] p-2">
                  <code className="flex-1 break-all font-mono text-[11px] text-emerald-200">{create.data.command}</code>
                  <button type="button" onClick={() => void copy()} aria-label="Copy the command" className="text-slate-400 hover:text-slate-100">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500">The command works once, until {new Date(create.data.expiresAt).toLocaleTimeString()}.</p>
                <ol className="space-y-1">
                  {STEPS.map((step, index) => {
                    const reached = status ? STEPS.findIndex((s) => s.status === status) >= index : index === 0
                    const current = step.status === status
                    return (
                      <li key={step.status} className={`flex items-center gap-2 text-xs ${reached ? 'text-slate-200' : 'text-slate-500'}`}>
                        {current && status !== 'ready' ? <Loader2 size={12} className="animate-spin" /> : <span className={`h-2 w-2 rounded-full ${reached ? 'bg-emerald-400' : 'bg-slate-600'}`} />}
                        {step.label}
                      </li>
                    )
                  })}
                </ol>
                {status === 'failed' && <p role="alert" className="text-xs text-rose-300">{setup.data?.detail ?? 'The install stopped.'} Make a new command and run it again.</p>}
                {setup.data?.detail && status !== 'failed' && <p className="text-[11px] text-slate-400">{setup.data.detail}</p>}
              </div>
            )}
            {create.isError && <p role="alert" className="text-xs text-rose-300">{errorMessage(create.error)}</p>}
            {startPool.isError && <p role="alert" className="text-xs text-rose-300">{errorMessage(startPool.error)}</p>}
          </>
        )}
        <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><LogOut size={12} /> Sign out</button>
      </div>
    </div>
  )
}
