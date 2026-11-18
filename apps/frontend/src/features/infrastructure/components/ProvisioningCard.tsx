import { CheckCircle2, Circle, Loader2, RotateCcw, XCircle } from 'lucide-react'
import type { ProvisionPieceState } from '@koala/engine-core/koala-install'
import { errorMessage } from '../../../api/client'
import { useCan } from '../../platform'
import { Section } from '../../monitoring'
import { useProvisioning, useSetUpAgain } from '../hooks/useProvisioning'
import { provisioningShown, type PieceShown, type SetupShown } from '../lib/provisioning'
import { QuietButton } from './Parts'

const TITLE = 'Setting Koala up'

const row = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2 text-[12px]'

function PieceIcon({ state }: { state: ProvisionPieceState }) {
  if (state === 'up') return <CheckCircle2 size={12} className="text-emerald-300" />
  if (state === 'working') return <Loader2 size={12} className="animate-spin text-sky-300" />
  if (state === 'failed') return <XCircle size={12} className="text-rose-300" />
  return <Circle size={12} className="text-slate-500" />
}

function Piece({ piece }: { piece: PieceShown }) {
  const tone = piece.state === 'failed' ? 'text-rose-300' : piece.state === 'up' ? 'text-emerald-300' : 'text-slate-400'
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]" data-testid={`provisioning-piece-${piece.key}`}>
      <PieceIcon state={piece.state} />
      <span className="font-semibold text-slate-100">{piece.title}</span>
      <span className={tone}>{piece.words}</span>
    </li>
  )
}

function Setup({ setup }: { setup: SetupShown }) {
  const again = useSetUpAgain()
  if (setup.kind === 'up') {
    return (
      <div className={`${row} flex-col items-stretch`}>
        <p className="flex items-center gap-2 text-emerald-300"><CheckCircle2 size={14} /> {setup.line}</p>
        {setup.root && <p role="alert" className="text-rose-300">{setup.root}</p>}
      </div>
    )
  }
  return (
    <div className={`${row} flex-col items-stretch`} data-testid="provisioning-setup">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-slate-100">{setup.heading}</span>
        <span className="text-[11px] text-slate-500">{setup.because}</span>
      </div>
      <ul className="space-y-1" aria-label={setup.heading}>
        {setup.pieces.map((piece) => <Piece key={piece.key} piece={piece} />)}
      </ul>
      {setup.failed && <p role="alert" className="text-rose-300">{setup.failed}</p>}
      {setup.root && <p role="alert" className="text-rose-300">{setup.root}</p>}
      {setup.again && (
        <div className="flex items-center gap-2">
          <QuietButton onClick={() => again.mutate(setup.key)} disabled={again.isPending}><RotateCcw size={11} /> Set up again</QuietButton>
          {again.isError && <span className="text-[11px] text-rose-300">{errorMessage(again.error)}</span>}
        </div>
      )}
    </div>
  )
}

export function ProvisioningCard() {
  const view = useProvisioning()
  const can = useCan()

  if (view.isPending) return <Section title={TITLE}><div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading how far Koala is with setting itself up…</div></Section>
  if (view.isError) return <Section title={TITLE}><p className="text-[12px] text-rose-300">{errorMessage(view.error)}</p></Section>

  const shown = provisioningShown(view.data.setups, can('set-up-again', view.data))

  return (
    <Section title={TITLE}>
      {shown.kind === 'not-started' && <p className="text-[12px] text-slate-400">{shown.line}</p>}
      {shown.kind === 'set-up' && <p className="flex items-center gap-2 text-[12px] text-emerald-300"><CheckCircle2 size={14} /> {shown.line}</p>}
      {shown.kind === 'setting-up' && (
        <div className="space-y-2">
          {shown.setups.map((setup) => <Setup key={setup.key} setup={setup} />)}
        </div>
      )}
    </Section>
  )
}

export default ProvisioningCard
