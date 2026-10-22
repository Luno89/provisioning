import { Box, Trees as TreesIcon, ShieldCheck, ShieldAlert, Terminal } from 'lucide-react'
import type { ProjectRow } from '../shared.js'
import { ProjectStatusBadge } from './StatusBadge.js'
import { ProjectPulse } from './Strip/ProjectPulse.js'

const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export interface LocalAgentSummary {
  id: string
  name: string
}

export function ProjectCard({ row, onOpen, localAgents = [] }: {
  row: ProjectRow
  onOpen: () => void
  localAgents?: readonly LocalAgentSummary[]
}) {
  const localTarget = row.project?.executionTarget?.kind === 'local-device' ? row.project.executionTarget : undefined
  const localDeviceId = localTarget?.deviceId
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 hover:border-[var(--bark-700)] transition-colors p-4 sm:p-5 flex items-center gap-3"
    >
      <div className={`p-2 rounded-md shrink-0 ${row.project ? 'bg-blue-500/10 text-blue-400' : 'bg-[var(--leaf-stem)]/10 text-[var(--leaf)]'}`}>
        {row.project ? <Box size={20} /> : <TreesIcon size={20} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="font-semibold text-sm text-slate-100 truncate">{row.name}</h4>
          {row.project?.giteaRepo && row.project.giteaRepo !== slugOf(row.name) && (
            <span className="text-[10px] font-mono text-slate-500" title={`${row.project.giteaOwner}/${row.project.giteaRepo}`}>
              {row.project.giteaRepo}
            </span>
          )}
          {row.project?.autoDeployOnBuild && (
            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
              <ShieldCheck size={10} /> auto-deploy
            </span>
          )}
          {localDeviceId && (
            <span
              className="text-[10px] font-mono text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded flex items-center gap-1"
              title="This project's work runs on a local machine, not a sandboxed cluster"
            >
              <Terminal size={10} />
              Local machine: {localAgents.find((d) => d.id === localDeviceId)?.name ?? 'unknown'}
              {localTarget?.path ? ` · ${localTarget.path}` : ''}
            </span>
          )}
          {localDeviceId && row.project?.executionApproval !== 'auto' && (
            <span
              className="text-[10px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded flex items-center gap-1"
              title="Each command needs your approval before it runs"
            >
              <ShieldAlert size={10} /> approval required
            </span>
          )}
          {row.tree && !row.project && (
            <span className="text-[11px] text-slate-500 italic">no repository yet</span>
          )}
          {!row.tree && row.project && (
            <span className="text-[11px] text-slate-500 italic">no conversation yet</span>
          )}
        </div>
        <ProjectPulse treeId={row.tree?.id} projectId={row.project?.id} />
      </div>
      {row.project && <ProjectStatusBadge status={row.project.status} reason={row.project.reason} />}
    </button>
  )
}

export default ProjectCard
