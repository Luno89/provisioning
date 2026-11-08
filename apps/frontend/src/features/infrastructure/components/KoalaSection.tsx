import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { ago } from '../../projects'
import { Section, StateBadge } from '../../monitoring'
import { koalaFigures, missingTelemetryLine, NOT_MEASURED, reportingLine } from '../lib/koala-figures'
import type { KoalaView } from '../api/infrastructure'
import { sectionAnchor, useInfrastructure, useKoala } from '../shared'

type KoalaRead = { isPending: boolean; isError: boolean; error: unknown; koala: KoalaView | undefined }

function KoalaPanel({ read, about }: { read: KoalaRead; about: string }) {
  if (read.isPending) return <Section id={sectionAnchor('koala')} title="Koala"><div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading what Koala reports about itself…</div></Section>
  if (read.isError || !read.koala) return <Section id={sectionAnchor('koala')} title="Koala"><p className="text-[12px] text-rose-300">{errorMessage(read.error)}</p></Section>

  const { koala } = read
  const measured = koala.state !== 'installing' && koala.state !== 'unreachable'
  const missing = missingTelemetryLine(koala.telemetry)

  return (
    <Section id={sectionAnchor('koala')} title="Koala" right={<span className="text-[11px] text-slate-500">checked {ago(koala.checkedAt)}</span>}>
      <p className="text-[11px] text-slate-500">{about}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" data-testid="koala-state">
        <StateBadge state={koala.state} />
        <span className="text-slate-300">{koala.lines[0]}</span>
      </div>
      {measured && (
        <>
          <p className="text-[12px] text-slate-400" data-testid="koala-services">{reportingLine(koala.services)}</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3 lg:grid-cols-5" aria-label="Koala's own numbers">
            {koalaFigures(koala.numbers).map((figure) => (
              <div key={figure.label} className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2">
                <dt className="text-[11px] text-slate-500">{figure.label}</dt>
                <dd className={`font-semibold ${figure.value === NOT_MEASURED ? 'text-slate-500' : 'text-slate-100'}`}>{figure.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {missing && <p className="text-[11px] text-amber-300">{missing}</p>}
    </Section>
  )
}

export function KoalaSection() {
  const view = useInfrastructure()
  return <KoalaPanel read={{ isPending: view.isPending, isError: view.isError, error: view.error, koala: view.data?.koala }} about="What Koala reports about itself: its requests, model calls and work, read from the Prometheus of the cluster this Koala runs in, through its collector." />
}

export function RootKoala() {
  const view = useKoala()
  return <KoalaPanel read={{ isPending: view.isPending, isError: view.isError, error: view.error, koala: view.data }} about="What root reports about itself: its requests and work, read from root's cluster's Prometheus through its collector." />
}

export default KoalaSection
