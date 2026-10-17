import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, Trash2 } from 'lucide-react'
import type { ClusterContents, Workload } from '../../api/infrastructure'
import { clusterDashboardUrl } from '../../api/clusters'
import { errorMessage } from '../../api/client'
import { formatHash } from '../../lib/route'
import { useShellStore } from '../../stores/shell'
import { ClusterHealth } from '../Monitoring/ClusterHealth'
import { Section } from '../Monitoring/Parts'
import { useShellContext } from '../shell-context'
import { GpuPanel } from './GpuPanel'
import { QuietButton, WorkloadBadge } from './Parts'
import { GROUPS, aboutLink, bytes, useClusterContents } from './shared'

function WorkloadRow({ workload }: { workload: Workload }) {
  const about = aboutLink(workload.about)
  return (
    <tr className="border-t border-[var(--bark-700)] align-top" data-testid="workload-row">
      <td className="px-3 py-1.5">
        <div className="font-semibold text-slate-100">{workload.name}</div>
        <div className="text-[11px] text-slate-500">
          {workload.kind} in {workload.namespace}
          {workload.release && workload.release !== workload.namespace ? ` · ${workload.release}` : ''}
          {about && (about.href ? <> · <a href={about.href} className="text-slate-300 hover:underline">{about.label}</a></> : ` · ${about.label}`)}
        </div>
      </td>
      <td className="px-3 py-1.5">
        <WorkloadBadge state={workload.state} />
        {workload.reasons.length > 0 && <div className="mt-0.5 max-w-[22rem] text-[11px] text-slate-400">{workload.reasons.join('; ')}</div>}
      </td>
      <td className="px-3 py-1.5 text-slate-300">{workload.pods.ready}/{workload.pods.total}</td>
      <td className="px-3 py-1.5 text-slate-300">{workload.restarts}</td>
      <td className="px-3 py-1.5 text-slate-300">{bytes(workload.memoryBytes)}</td>
      <td className="px-3 py-1.5 text-slate-300">{workload.cpuCores === undefined ? '—' : workload.cpuCores < 0.01 ? '<0.01' : workload.cpuCores.toFixed(2)}</td>
    </tr>
  )
}

function Workloads({ contents }: { contents: ClusterContents }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ apps: true, koala: true })
  const groups = GROUPS.map((group) => ({ ...group, workloads: contents.workloads.filter((workload) => workload.group === group.id) })).filter((group) => group.workloads.length)
  return (
    <Section
      title="Workloads"
      right={<span className="text-[11px] text-slate-500">{contents.measured ? '' : 'memory and CPU are not measured here yet · '}{contents.finishedJobs ? `${contents.finishedJobs} finished job${contents.finishedJobs === 1 ? '' : 's'} not shown` : ''}</span>}
    >
      {!contents.reachable && <p className="text-[12px] text-amber-300">What is on it cannot be read: {contents.problem}.</p>}
      {contents.reachable && !groups.length && <p className="text-[12px] text-slate-500">Nothing of yours runs on it.</p>}
      {groups.map((group) => {
        const broken = group.workloads.filter((workload) => workload.state === 'down' || workload.state === 'warning').length
        const shown = open[group.id] ?? broken > 0
        return (
          <div key={group.id} className="rounded-md border border-[var(--bark-700)]" data-testid={`workload-group-${group.id}`}>
            <button type="button" onClick={() => setOpen((now) => ({ ...now, [group.id]: !shown }))} aria-expanded={shown} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-[var(--bark-800)]">
              {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="font-semibold text-slate-100">{group.title}</span>
              <span className="text-slate-500">{group.workloads.length}</span>
              {broken > 0 && <span className="text-amber-300">{broken} need{broken === 1 ? 's' : ''} attention</span>}
              <span className="ml-auto hidden text-[11px] text-slate-500 sm:inline">{group.explain}</span>
            </button>
            {shown && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="bg-[var(--bark-900)] text-[11px] text-slate-500">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Workload</th>
                      <th className="px-3 py-1.5 font-medium">State</th>
                      <th className="px-3 py-1.5 font-medium">Ready</th>
                      <th className="px-3 py-1.5 font-medium">Restarts</th>
                      <th className="px-3 py-1.5 font-medium">Memory</th>
                      <th className="px-3 py-1.5 font-medium">CPU</th>
                    </tr>
                  </thead>
                  <tbody>{group.workloads.map((workload) => <WorkloadRow key={`${workload.namespace}/${workload.kind}/${workload.name}`} workload={workload} />)}</tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

function PlatformServices({ contents, system }: { contents: ClusterContents; system: boolean }) {
  if (!contents.services) return null
  return (
    <Section
      title="Platform services"
      right={system ? <a href={formatHash('nginx')} className="text-[11px] text-slate-400 hover:text-slate-200 hover:underline">Local router (Nginx)</a> : undefined}
    >
      <p className="text-[11px] text-slate-500">Opening a dashboard signs you in with a session of its own; no password reaches your browser.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {contents.services.map((service) => (
          <div key={service.key} className="space-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 text-[12px]" data-testid="platform-service">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-100">{service.label}</span>
              <WorkloadBadge state={service.state} />
            </div>
            <p className="text-[11px] text-slate-500">{service.does}{service.release ? ` · ${service.release.chart}${service.release.version ? ` ${service.release.version}` : ''}` : ''}{service.installed ? ` · ${service.pods.ready}/${service.pods.total} ready` : ''}</p>
            <p className="text-[11px] text-slate-400">{service.access}</p>
            {service.reasons.length > 0 && <p className="text-[11px] text-amber-300">{service.reasons.join('; ')}</p>}
            {service.dashboard && (
              <a href={clusterDashboardUrl(contents.clusterId, service.key)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:underline">
                Open dashboard <ExternalLink size={10} />
              </a>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

function Nodes({ contents }: { contents: ClusterContents }) {
  if (!contents.nodes?.length) return null
  return (
    <Section title="Nodes">
      <ul className="space-y-1 text-[12px]">
        {contents.nodes.map((node) => (
          <li key={node.name} className="flex flex-wrap items-center gap-x-3 text-slate-300" data-testid="node-row">
            <span className={`text-[11px] font-semibold ${node.ready ? 'text-emerald-300' : 'text-rose-300'}`}>{node.ready ? 'Ready' : 'Not ready'}</span>
            <span className="font-semibold text-slate-100">{node.name}</span>
            <span className="text-slate-500">{node.roles.join(', ') || 'worker'}{node.version ? ` · ${node.version}` : ''}</span>
            <span>{node.cpuCores ?? '—'} CPU · {bytes(node.memoryBytes)}{node.gpus ? ` · ${node.gpus} GPU` : ''}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Releases({ contents }: { contents: ClusterContents }) {
  const [open, setOpen] = useState(false)
  if (!contents.releases?.length) return null
  const failing = contents.releases.filter((release) => release.status !== 'deployed')
  return (
    <Section title="Helm releases" right={<QuietButton onClick={() => setOpen(!open)}>{open ? 'Hide' : `Show all ${contents.releases.length}`}</QuietButton>}>
      {failing.length > 0 && <p className="text-[12px] text-amber-300">{failing.map((release) => `${release.name} is ${release.status}`).join('; ')}</p>}
      {open && (
        <ul className="grid gap-1 text-[12px] sm:grid-cols-2" data-testid="helm-releases">
          {contents.releases.map((release) => (
            <li key={`${release.namespace}/${release.name}`} className="flex justify-between gap-2 text-slate-300">
              <span><span className="font-semibold text-slate-100">{release.name}</span> <span className="text-slate-500">{release.chart}{release.app_version ? ` · ${release.app_version}` : ''}</span></span>
              <span className={release.status === 'deployed' ? 'text-emerald-300' : 'text-amber-300'}>{release.status}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function ClusterPage({ clusterId }: { clusterId: string }) {
  const ctx = useShellContext()
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy)
  const contents = useClusterContents(clusterId)
  const cluster = ctx?.clusters.find((entry) => entry.id === clusterId)
  const actions = cluster && !cluster.isSystem && ctx ? (
    <>
      <QuietButton onClick={() => ctx.openDashboard('cluster', cluster.id)}><FileText size={11} /> Logs</QuietButton>
      <QuietButton danger onClick={() => setConfirmDestroy({ type: 'cluster', id: cluster.id, name: cluster.name, isAbort: cluster.status === 'provisioning' })}><Trash2 size={11} /> {cluster.status === 'provisioning' ? 'Abort' : 'Destroy'}</QuietButton>
    </>
  ) : undefined

  return (
    <div className="space-y-6" data-testid="cluster-page">
      <ClusterHealth clusterId={clusterId} standalone actions={actions} />
      {contents.isPending && <div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading what is on it…</div>}
      {contents.isError && <p className="text-[12px] text-rose-300">{errorMessage(contents.error)}</p>}
      {contents.data && (
        <>
          <Workloads contents={contents.data} />
          <PlatformServices contents={contents.data} system={Boolean(cluster?.isSystem)} />
          <Nodes contents={contents.data} />
          {contents.data.ownsCluster && <GpuPanel clusterId={clusterId} passthrough={Boolean(cluster?.gpuEnabled)} />}
          <Releases contents={contents.data} />
        </>
      )}
    </div>
  )
}

export default ClusterPage
