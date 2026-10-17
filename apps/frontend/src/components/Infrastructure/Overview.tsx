import { useEffect } from 'react'
import { CheckCircle2, Hand, Loader2, XCircle } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { ago } from '../home-summary'
import { EpisodeList, FiringList, RuleList, Section, StateBadge } from '../Monitoring/Parts'
import { useAlerts } from '../Monitoring/shared'
import { hashFor } from './opens'
import { AppsSection } from './AppsSection'
import { ClustersSection } from './ClustersSection'
import { QuietButton, WorkloadBadge } from './Parts'
import RunningSection from './RunningSection'
import { aboutLink, healthHash, sectionAnchor, useClearFailures, useInfrastructure, waitingText, type SectionId } from './shared'

const row = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2 text-[12px]'

function NeedsAttention() {
  const view = useInfrastructure()
  const clear = useClearFailures()

  if (view.isPending) return <Section title="Needs attention"><div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading every cluster and what runs…</div></Section>
  if (view.isError) return <Section title="Needs attention"><p className="text-[12px] text-rose-300">{errorMessage(view.error)}</p></Section>

  const { monitoring, workloads, waiting, failures, runningProblem } = view.data
  const nothing = !waiting.length && !monitoring.attention.length && !workloads.length && !failures.length && !monitoring.firing.length

  return (
    <Section title="Needs attention" right={<span className="text-[11px] text-slate-500">checked {ago(monitoring.checkedAt)}</span>}>
      {nothing ? (
        <p className="flex items-center gap-2 text-[12px] text-emerald-300"><CheckCircle2 size={14} /> {runningProblem ? 'Everything is healthy.' : 'Everything is healthy, and nothing waits on you.'}</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Needs attention">
          {waiting.map((item) => (
            <li key={item.workflowId}>
              <a href={hashFor(item.opens)} className={`${row} hover:bg-[var(--bark-800)]`}>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-300"><Hand size={11} /> Waiting on you</span>
                <span className="font-semibold text-slate-100">{item.title}</span>
                <span className="text-slate-400">{waitingText(item)}</span>
              </a>
            </li>
          ))}
          {monitoring.attention.map((item) => (
            <li key={`${item.subject.kind}:${item.subject.id}`}>
              <a href={healthHash(item.subject.kind, item.subject.id)} className={`${row} hover:bg-[var(--bark-800)]`}>
                <StateBadge state={item.state} />
                <span className="font-semibold text-slate-100">{item.subject.name}</span>
                <span className="text-slate-400">{item.reasons.join('; ')}</span>
              </a>
            </li>
          ))}
          {workloads.map((workload) => {
            const about = aboutLink(workload.about)
            return (
              <li key={`${workload.clusterId}/${workload.namespace}/${workload.kind}/${workload.name}`}>
                <a href={healthHash('cluster', workload.clusterId)} className={`${row} hover:bg-[var(--bark-800)]`} data-testid="attention-workload">
                  <WorkloadBadge state={workload.state} />
                  <span className="font-semibold text-slate-100">{workload.name}</span>
                  <span className="text-[11px] text-slate-500">{workload.namespace} on {workload.clusterName}{about ? `, ${about.label}` : ''}</span>
                  <span className="text-slate-400">{workload.reasons.join('; ')}</span>
                </a>
              </li>
            )
          })}
          {failures.map((failure) => (
            <li key={failure.id} className={row} data-testid="attention-failure">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-300"><XCircle size={11} /> Failed {ago(failure.failedAt)}</span>
              <a href={hashFor(failure.opens)} className="font-semibold text-slate-100 hover:underline">{failure.title}</a>
              <span className="flex-1 text-slate-400">{failure.reason}</span>
              <QuietButton onClick={() => clear.mutate([failure.id])} disabled={clear.isPending} label={`Clear ${failure.title}`}>Clear</QuietButton>
            </li>
          ))}
        </ul>
      )}
      {failures.length > 1 && (
        <div className="flex justify-end">
          <QuietButton onClick={() => clear.mutate(undefined)} disabled={clear.isPending}>Clear all {failures.length} failures</QuietButton>
        </div>
      )}
      {clear.isError && <p className="text-[11px] text-rose-300">{errorMessage(clear.error)}</p>}
      {runningProblem && <p className="text-[11px] text-amber-300">What runs cannot be read: {runningProblem}.</p>}
      <FiringList firing={monitoring.firing} />
    </Section>
  )
}

export function Overview({ focus }: { focus?: SectionId }) {
  const alerts = useAlerts()
  const loaded = Boolean(useInfrastructure().data)

  useEffect(() => {
    if (focus) document.getElementById(sectionAnchor(focus))?.scrollIntoView({ block: 'start' })
  }, [focus, loaded])

  return (
    <div className="space-y-6" data-testid="infrastructure-overview">
      <NeedsAttention />
      <AppsSection />
      <ClustersSection />
      <RunningSection />

      <Section title="Alerts set">
        {alerts.data ? <RuleList rules={alerts.data.rules} /> : <Loader2 size={12} className="animate-spin text-slate-500" />}
      </Section>
      <Section title="Alert history">
        {alerts.data ? <EpisodeList episodes={alerts.data.episodes} /> : <Loader2 size={12} className="animate-spin text-slate-500" />}
      </Section>
    </div>
  )
}

export default Overview
