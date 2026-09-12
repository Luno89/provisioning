import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Box, ExternalLink, ShieldCheck, AlertTriangle, History, Terminal } from 'lucide-react'
import PipelineLogModal from '../../PipelineLogModal.js'
import { PipelineRunRow, type PipelineRun } from '../../PipelineRunRow.js'
import { listProjectRuns, listProjects, patchProject, projectKeys } from '../../../api/projects.js'
import { listLocalAgentDevices, localAgentKeys, type LocalAgentDevice } from '../../../api/local-agents.js'
import { ProjectStatusBadge } from '../StatusBadge.js'

export interface LinkedProject {
  id: string
  name: string
  giteaOwner: string
  giteaRepo: string
  autoDeployOnBuild?: boolean | undefined
  status?: string | undefined
  reason?: string | undefined
  targetClusterId?: string | undefined
  lastBuildStatus?: string | undefined
  executionTarget?: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string; path?: string } | undefined
}

interface ProjectExecutionSummary {
  id: string
  name: string
  executionTarget?: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string; path?: string } | undefined
}

export function BuildsDeploysPanel({ project }: { project: LinkedProject }) {
  const qc = useQueryClient()
  const [logRunId, setLogRunId] = useState<string | null>(null)

  const { data: projectRuns = [] } = useQuery<PipelineRun[]>({
    queryKey: ['project-runs', project.id],
    queryFn: () => listProjectRuns<PipelineRun>(project.id),
    refetchInterval: (query) => ((query.state.data || []).some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false),
  })
  const liveRunId = project.status === 'running'
    ? projectRuns
      .filter((r) => r.deploymentId)
      .sort((a, b) => (b.promotedAt ?? '').localeCompare(a.promotedAt ?? ''))[0]?.id
    : undefined

  const { data: localAgents = [] } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
  })
  const { data: allProjects = [] } = useQuery<ProjectExecutionSummary[]>({
    queryKey: projectKeys.list(),
    queryFn: () => listProjects<ProjectExecutionSummary>(),
  })
  const claimedBy = (deviceId: string) => allProjects.find((p) =>
    p.id !== project.id && p.executionTarget?.kind === 'local-device' && p.executionTarget.deviceId === deviceId
    && (p.executionTarget.path ?? '') === '')
  const currentDeviceId = project.executionTarget?.kind === 'local-device' ? project.executionTarget.deviceId : ''

  const setDevice = useMutation({
    mutationFn: (deviceId: string) => patchProject(project.id, { executionTargetDeviceId: deviceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.list() }),
  })

  return (
    <div className="overflow-y-auto p-3 space-y-4 font-mono">
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Box size={14} className="text-blue-400 shrink-0" />
          <span className="text-[11px] font-bold text-slate-200 truncate" title={`${project.giteaOwner}/${project.giteaRepo}`}>
            {project.giteaOwner}/{project.giteaRepo}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <ProjectStatusBadge status={project.status} reason={project.reason} />
          {project.autoDeployOnBuild && (
            <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0">
              <ShieldCheck size={10} /> auto-deploy
            </span>
          )}
          {project.status === 'running' && (
            <a
              href={`http://${project.name.toLowerCase()}.apps.local`}
              target="_blank"
              rel="noreferrer"
              className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[11px] font-medium px-2 py-0.5 rounded flex items-center gap-1 transition-colors shrink-0"
            >
              <ExternalLink size={11} /> Open App
            </a>
          )}
        </div>

        {project.reason && (
          <p className="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded-md px-2.5 py-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5 text-rose-400" />
            <span className="break-words">{project.reason}</span>
          </p>
        )}

        <div className="text-[11px] text-slate-400 flex flex-col gap-1 pt-2 border-t border-[var(--bark-800)]/60">
          <span>Cluster: <span className="text-slate-300">{project.targetClusterId || 'default'}</span></span>
          {project.lastBuildStatus && <span>Build: <span className="text-slate-300">{project.lastBuildStatus}</span></span>}
        </div>

        <div className="space-y-1.5 pt-2 border-t border-[var(--bark-800)]/60">
          <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
            <Terminal size={11} /> Execution target
          </label>
          <select
            value={currentDeviceId}
            onChange={(e) => setDevice.mutate(e.target.value)}
            disabled={setDevice.isPending}
            className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-2 py-1.5 text-[11px] text-slate-200 disabled:opacity-50"
          >
            <option value="">Sandboxed cluster (default)</option>
            {localAgents.map((d) => {
              const claim = claimedBy(d.id)
              return (
                <option key={d.id} value={d.id} disabled={Boolean(claim)}>
                  {d.name}{d.online ? '' : ' (offline)'}{claim ? ` — in use by ${claim.name}` : ''}
                </option>
              )
            })}
          </select>
          {setDevice.isError && (
            <p className="text-[11px] text-rose-400">
              {(setDevice.error as any)?.response?.data?.error || 'Could not update the execution target.'}
            </p>
          )}
        </div>
      </div>

      {projectRuns.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
            <History size={11} /> Deployment & Change Log
          </h4>
          <div className="space-y-2">
            {projectRuns.map((r) => (
              <PipelineRunRow key={r.id} run={r} isLive={r.id === liveRunId} onViewLogs={setLogRunId} />
            ))}
          </div>
        </div>
      )}

      {logRunId && <PipelineLogModal runId={logRunId} onClose={() => setLogRunId(null)} />}
    </div>
  )
}

export default BuildsDeploysPanel
