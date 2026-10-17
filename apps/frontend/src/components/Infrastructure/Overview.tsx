import { CheckCircle2, Hand, Loader2, XCircle } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { ago } from '../home-summary'
import { EpisodeList, FiringList, RuleList, Section, StateBadge } from '../Monitoring/Parts'
import { useAlerts } from '../Monitoring/shared'
import { hashFor } from './opens'
import { QuietButton, WorkloadBadge } from './Parts'
import { aboutLink, healthHash, tabHash, useClearFailures, useInfrastructure, waitingText } from './shared'

const row = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2 text-[12px]'

export function Overview() {
  const view = useInfrastructure()
  const alerts = useAlerts()
  const clear = useClearFailures()

  if (view.isPending) return <div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading every cluster and what runs…</div>
  if (view.isError) return <p className="text-[12px] text-rose-300">{errorMessage(view.error)}</p>

  const { monitoring, workloads, waiting, failures, running, runningProblem } = view.data
  const nothing = !waiting.length && !monitoring.attention.length && !workloads.length && !failures.length && !monitoring.firing.length
  const unhealthyApps = monitoring.apps.filter((app) => app.state !== 'ok').length
  const unhealthyClusters = monitoring.clusters.filter((cluster) => cluster.state !== 'ok').length

  return (
    <div className="space-y-6" data-testid="infrastructure-overview">
      <Section title="Needs attention" right={<span className="text-[11px] text-slate-500">checked {ago(monitoring.checkedAt)}</span>}>
        {nothing ? (
          <p className="flex items-center gap-2 text-[12px] text-emerald-300"><CheckCircle2 size={14} /> Everything is healthy, and nothing waits on you.</p>
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
        <FiringList firing={monitoring.firing} />
      </Section>

      <div className="grid gap-3 sm:grid-cols-3">
        <a href={tabHash('apps')} className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 hover:bg-[var(--bark-800)]">
          <div className="text-[11px] text-slate-500">Apps</div>
          <div className="text-lg font-semibold text-slate-100">{monitoring.apps.length}</div>
          <div className="text-[11px] text-slate-400">{unhealthyApps ? `${unhealthyApps} not healthy` : 'all healthy'}</div>
        </a>
        <a href={tabHash('clusters')} className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 hover:bg-[var(--bark-800)]">
          <div className="text-[11px] text-slate-500">Clusters</div>
          <div className="text-lg font-semibold text-slate-100">{monitoring.clusters.length}</div>
          <div className="text-[11px] text-slate-400">{unhealthyClusters ? `${unhealthyClusters} not healthy` : 'all healthy'}</div>
        </a>
        <a href={tabHash('running')} className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 hover:bg-[var(--bark-800)]">
          <div className="text-[11px] text-slate-500">Running</div>
          <div className="text-lg font-semibold text-slate-100">{runningProblem ? '—' : running}</div>
          <div className="text-[11px] text-slate-400">{runningProblem ?? (waiting.length ? `${waiting.length} waiting on you` : 'nothing waits on you')}</div>
        </a>
      </div>

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
