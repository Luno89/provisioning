import { useEffect, useState } from 'react'
import { HardDrive, Loader2, LogOut, RotateCcw } from 'lucide-react'
import { useInstanceReady, useMySetup, useNameCheck, useSetMyKoalaUpAgain, type InstanceStatus, type MySetup } from '../api/instances'
import { errorMessage } from '../../../api/client'
import { useCan } from '../../platform'
import { UnreachableSwitch } from './InstanceWatch'
import { useSetMyWatch } from '../api/instance-watch'
import { INSTANCE_GO_URL } from '../api/identity'
import { AccountMachines } from '../../machines'

export interface NoInstanceProps {
  hasInstance: boolean
  unreachableSince?: string | undefined
  signInWaiting?: string | undefined
  onLogout: () => void
}

const STEPS: { status: InstanceStatus; label: string }[] = [
  { status: 'waiting', label: 'Waiting for your machine to run the command and connect' },
  { status: 'joined', label: 'Your machine is putting Koala on itself' },
  { status: 'installing', label: 'Installing Koala' },
  { status: 'ready', label: 'Ready' },
]

function InstanceDown({ since }: { since: string }) {
  const setup = useMySetup(true)
  const change = useSetMyWatch()
  const ready = useInstanceReady()
  const watch = setup.data?.watch
  const back = watch?.reach?.reachable === true
  useEffect(() => {
    if (back) ready()
  }, [back, ready])
  return (
    <div className="space-y-3" data-testid="instance-down">
      <p className="text-sm font-semibold">Your instance is not answering</p>
      <p className="text-xs leading-relaxed text-slate-400">
        Root has not reached it since {new Date(since).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
        If it runs on your own machine, that machine may be off, asleep or offline; once it answers, signing in here takes you straight to it again.
      </p>
      <a href={INSTANCE_GO_URL} className="inline-block text-xs font-semibold text-sky-300 hover:text-sky-200">Try to open it anyway</a>
      {watch && <UnreachableSwitch view={watch} saving={change.isPending} error={change.error} onChange={(on) => change.mutate(on)} />}
    </div>
  )
}

function SetupStopped({ mine }: { mine: MySetup }) {
  const can = useCan()
  const again = useSetMyKoalaUpAgain()
  return (
    <div className="space-y-2">
      <p role="alert" className="text-xs text-rose-300">{mine.detail ?? 'Koala stopped setting itself up.'}</p>
      {can('set-up-again', mine) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => again.mutate(mine.id)}
            disabled={again.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--bark-700)] px-2 py-1 text-[11px] font-medium text-slate-200 disabled:opacity-50"
          >
            {again.isPending ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Set up again
          </button>
          {again.isError && <span className="text-[11px] text-rose-300">{errorMessage(again.error)}</span>}
        </div>
      )}
    </div>
  )
}

export default function NoInstance({ hasInstance, unreachableSince, signInWaiting, onLogout }: NoInstanceProps) {
  const operator = useCan()('manage-accounts')
  const [ownMachine, setOwnMachine] = useState(false)
  const [placing, setPlacing] = useState(false)
  const setup = useMySetup(false)
  const ready = useInstanceReady()
  const status = setup.data?.status
  const following = placing || Boolean(status && status !== 'waiting')
  const fixedName = setup.data?.name
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const suggestion = useNameCheck('')
  const name = fixedName ?? typed ?? suggestion.data?.suggestion ?? ''
  const check = useNameCheck(name)
  const nameOk = Boolean(name) && (check.data?.ok ?? false)

  useEffect(() => {
    if (status === 'ready') ready()
  }, [status, ready])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-8">
        {hasInstance && unreachableSince ? (
          <InstanceDown since={unreachableSince} />
        ) : hasInstance && signInWaiting ? (
          <div className="space-y-2" role="status">
            <p className="text-sm font-semibold">Your Koala is not ready for sign-in yet</p>
            <p className="text-xs leading-relaxed text-slate-400">Root can't send you on: {signInWaiting}.</p>
          </div>
        ) : hasInstance ? (
          <p className="flex items-center justify-center gap-2 text-sm text-slate-300"><Loader2 size={16} className="animate-spin" /> Taking you to your instance…</p>
        ) : (
          <>
            <p className="text-sm font-semibold">You don't have an instance yet</p>
            <p className="text-xs leading-relaxed text-slate-400">Your work runs on an instance of your own, on a machine you choose. Nothing about it is visible to anyone else.</p>
            {!following && (
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
            {!ownMachine && !following ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setOwnMachine(true)}
                    disabled={!nameOk}
                    className="inline-flex items-center gap-2 rounded-md bg-[var(--leaf-stem)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    <HardDrive size={14} /> Use my own machine
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <AccountMachines name={name} nameOk={nameOk} hasKoala={following && status !== 'failed'} onPlacing={() => setPlacing(true)} />
                {following && (
                  <>
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
                {status === 'failed' && setup.data?.setupAgain === 'stopped' && <SetupStopped mine={setup.data} />}
                {status === 'failed' && setup.data?.setupAgain !== 'stopped' && <p role="alert" className="text-xs text-rose-300">{setup.data?.detail ?? 'The install stopped.'} Put Koala on the machine again.</p>}
                {setup.data?.detail && status !== 'failed' && <p className="text-[11px] text-slate-400">{setup.data.detail}</p>}
                  </>
                )}
              </div>
            )}
          </>
        )}
        <div className="flex items-center gap-4">
          <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><LogOut size={12} /> Sign out</button>
          {operator && <a href="#/admin" className="text-xs text-slate-400 hover:text-slate-200">Admin</a>}
          <a href="#/remove-account" className="text-xs text-slate-500 hover:text-slate-300">Delete my account</a>
        </div>
      </div>
    </div>
  )
}
