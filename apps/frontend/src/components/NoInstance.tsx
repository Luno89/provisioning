import { useEffect, useState } from 'react'
import { Check, Copy, HardDrive, Loader2, LogOut } from 'lucide-react'
import { useCreateJoinCommand, useInstanceReady, useMySetup, type InstanceStatus } from '../api/instances'
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

export default function NoInstance({ hasInstance, onLogout }: NoInstanceProps) {
  const [copied, setCopied] = useState(false)
  const create = useCreateJoinCommand()
  const settingUp = Boolean(create.data)
  const setup = useMySetup(settingUp)
  const ready = useInstanceReady()
  const status = setup.data?.status

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
            {!create.data ? (
              <button
                type="button"
                onClick={() => create.mutate()}
                disabled={create.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--leaf-stem)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />} Use my own machine
              </button>
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
          </>
        )}
        <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><LogOut size={12} /> Sign out</button>
      </div>
    </div>
  )
}
