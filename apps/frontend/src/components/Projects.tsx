import { useSocketEvent } from '../stores/socket';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch, Plus, X, Loader2, CheckCircle2, XCircle, Clock,
  RefreshCw, AlertTriangle, ExternalLink, Box, ShieldCheck, ShieldAlert, Terminal,
} from 'lucide-react';
import PipelineLogModal from './PipelineLogModal.js';
import { PipelineRunRow, type PipelineRun } from './PipelineRunRow.js';
import {
  listProjects, listProjectRuns, projectKeys,
  createProject as createProjectApi, promoteRun as promoteRunApi,
} from '../api/projects';
import { listLocalAgentDevices, localAgentKeys, type LocalAgentDevice } from '../api/local-agents';

interface Project {
  id: string;
  name: string;
  giteaOwner: string;
  giteaRepo: string;
  targetClusterId?: string;
  targetNamespace?: string;
  executionTarget?: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string };
  executionApproval?: 'plan' | 'auto';
  appType: string;
  autoDeployOnBuild?: boolean;
  lastBuildStatus?: 'queued' | 'running' | 'succeeded' | 'failed';
  status?: 'no-build' | 'building' | 'build-failed' | 'built' | 'deploying' | 'deploy-failed' | 'unhealthy' | 'running';
  reason?: string;
  createdAt: string;
}

interface Cluster {
  id: string;
  name: string;
}

const PROJECT_STATUS: Record<string, { icon: any; className: string; label: string }> = {
  'no-build': { icon: Clock, className: 'text-slate-400 bg-slate-500/10 border-slate-700/50', label: 'No build yet' },
  building: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'Building Image' },
  'build-failed': { icon: XCircle, className: 'text-rose-400 bg-rose-500/10 border-rose-500/20', label: 'Build Failed' },
  built: { icon: CheckCircle2, className: 'text-slate-300 bg-slate-500/10 border-slate-700/50', label: 'Built (Ready)' },
  deploying: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'Deploying' },
  'deploy-failed': { icon: XCircle, className: 'text-rose-400 bg-rose-500/10 border-rose-500/20', label: 'Deploy Failed' },
  unhealthy: { icon: AlertTriangle, className: 'text-amber-400 bg-amber-500/10 border-amber-500/20', label: 'Workload Unhealthy' },
  running: { icon: CheckCircle2, className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', label: 'Running' },
};

function ProjectStatusBadge({ status, reason }: { status?: string | undefined; reason?: string | undefined }) {
  const s = PROJECT_STATUS[status || 'no-build'] || PROJECT_STATUS['no-build']!;
  const Icon = s.icon;
  const spinning = status === 'building' || status === 'deploying';
  return (
    <span
      title={reason || undefined}
      className={`text-[11px] font-medium font-mono px-2.5 py-1 rounded-md border flex items-center gap-1.5 w-fit ${s.className}`}
    >
      <Icon size={12} className={spinning ? 'animate-spin' : ''} /> {s.label}
    </span>
  );
}

export default function Projects({ clusters }: { clusters: Cluster[] }) {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [logRunId, setLogRunId] = useState<string | null>(null);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: projectKeys.list(),
    queryFn: () => listProjects<Project>(),
    refetchInterval: 5000,
  });

  const { data: runs = [] } = useQuery<PipelineRun[]>({
    queryKey: projectKeys.runs(expandedProject),
    queryFn: () => listProjectRuns<PipelineRun>(expandedProject!),
    enabled: !!expandedProject,
    refetchInterval: (query) => (query.state.data || []).some(r => r.status === 'queued' || r.status === 'running') ? 3000 : false,
  });

  const { data: localAgents = [] } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
  });

  const createProject = useMutation({
    mutationFn: (payload: unknown) => createProjectApi(payload),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['projects'] }); setShowCreateModal(false); },
  });

  const promoteRun = useMutation({
    mutationFn: ({ projectId, runId }: { projectId: string; runId: string }) =>
      promoteRunApi(projectId, runId),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
    },
  });

  useSocketEvent('deployment-updated', () => {
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  });

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[var(--bark-800)]/60">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2.5">
            <GitBranch size={20} className="text-blue-400" />
            Projects & CI/CD Pipelines
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Gitea repositories, automated Kaniko container image builds, and Kubernetes deployment pipelines.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
        >
          <Plus size={15} /> New Project
        </button>
      </header>

      {isLoading ? (
        <div className="text-slate-400 text-xs flex items-center gap-2 py-8">
          <Loader2 className="animate-spin text-blue-400" size={16} /> Loading project pipelines...
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-10 text-center max-w-xl mx-auto">
          <GitBranch className="mx-auto mb-3 text-slate-500" size={32} />
          <h3 className="text-sm font-semibold text-slate-200 mb-1">No registered projects yet</h3>
          <p className="text-slate-400 text-xs mb-4">
            Ask Koala to build a project or register a repository to automatically build and deploy container images.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> Register First Project
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {projects.map((p) => {
            const isExpanded = expandedProject === p.id;
            const liveUrl = `http://${p.name.toLowerCase()}.apps.local`;
            const localDeviceId = p.executionTarget?.kind === 'local-device' ? p.executionTarget.deviceId : undefined;
            return (
              <div
                key={p.id}
                className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 overflow-hidden transition-colors hover:border-[var(--bark-700)]"
              >
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start sm:items-center gap-3">
                      <div className="p-2 rounded-md bg-blue-500/10 text-blue-400 shrink-0 mt-0.5 sm:mt-0">
                        <Box size={20} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold text-sm text-slate-100">{p.name}</h4>
                          <span className="text-[11px] font-mono text-slate-400 bg-[var(--bark-800)] px-2 py-0.5 rounded">
                            {p.giteaOwner}/{p.giteaRepo}
                          </span>
                          {p.autoDeployOnBuild && (
                            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                              <ShieldCheck size={10} /> auto-deploy
                            </span>
                          )}
                          {localDeviceId && (
                            <span
                              className="text-[10px] font-mono text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded flex items-center gap-1"
                              title="This project's leaves execute on a local machine, not a sandboxed cluster"
                            >
                              <Terminal size={10} />
                              {localAgents.find((d) => d.id === localDeviceId)?.name ?? 'local machine'}
                            </span>
                          )}
                          {localDeviceId && p.executionApproval !== 'auto' && (
                            <span
                              className="text-[10px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded flex items-center gap-1"
                              title="Each command needs your approval before it runs"
                            >
                              <ShieldAlert size={10} /> approval required
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-3 mt-1 flex-wrap font-mono">
                          <span>Target: <span className="text-slate-300">{p.targetClusterId || 'default'}</span></span>
                          {p.targetNamespace && <span>NS: <span className="text-slate-300">{p.targetNamespace}</span></span>}
                          <span>Created: {new Date(p.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
                      <ProjectStatusBadge status={p.status} reason={p.reason} />
                      {p.status === 'running' && (
                        <a
                          href={liveUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors"
                        >
                          <ExternalLink size={12} /> Open App
                        </a>
                      )}
                      <button
                        onClick={() => setExpandedProject(isExpanded ? null : p.id)}
                        className="text-xs text-slate-300 hover:text-white bg-[var(--bark-800)] hover:bg-[var(--bark-700)] px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5"
                      >
                        <RefreshCw size={12} className={isExpanded ? 'rotate-180 transition-transform' : ''} />
                        {isExpanded ? 'Hide Runs' : 'Pipeline Runs'}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-[var(--bark-800)] space-y-3">
                      <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
                        <span className="font-semibold uppercase tracking-wider text-[10px]">Recent Kaniko Builds</span>
                        <span>Total Runs: {runs.length}</span>
                      </div>

                      {runs.length === 0 ? (
                        <p className="text-xs text-slate-400 py-2">
                          No builds yet. Push a commit to <code className="text-slate-300">{p.giteaOwner}/{p.giteaRepo}</code> on branch <code className="text-slate-300">main</code> to trigger an automated Kaniko build.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {runs.map((r) => (
                            <PipelineRunRow
                              key={r.id}
                              run={r}
                              isLive={Boolean(r.deploymentId) && p.status === 'running'}
                              onViewLogs={setLogRunId}
                              onPromote={(run) => promoteRun.mutate({ projectId: p.id, runId: run.id })}
                              promoting={promoteRun.isPending}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-[var(--bark-900)] border border-[var(--bark-700)] rounded-lg p-6 w-full max-w-md shadow-2xl space-y-5">
            <div className="flex justify-between items-center pb-3 border-b border-[var(--bark-800)]">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Plus size={16} className="text-blue-400" /> Register Project Repository
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                createProject.mutate({
                  name: d.get('name'),
                  giteaRepo: d.get('giteaRepo'),
                  createRepo: d.get('createRepo') === 'on',
                  targetClusterId: d.get('targetClusterId') || undefined,
                  targetNamespace: d.get('name'),
                  autoDeployOnBuild: d.get('autoDeployOnBuild') === 'on',
                  executionTargetDeviceId: d.get('executionTargetDeviceId') || undefined,
                  executionApproval: d.get('requireApproval') === 'on' ? 'plan' : 'auto',
                });
              }}
              className="space-y-4 text-xs"
            >
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Project Name
                </label>
                <input
                  name="name"
                  required
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="e.g. internal-dashboard"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Gitea Repository Name
                </label>
                <input
                  name="giteaRepo"
                  required
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                  placeholder="e.g. internal-dashboard"
                />
              </div>

              <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer pt-1">
                <input type="checkbox" name="createRepo" defaultChecked className="rounded accent-blue-600" />
                <span>Initialize new empty repository on Gitea</span>
              </label>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Target Cluster
                </label>
                <select
                  name="targetClusterId"
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="">Default Management Cluster</option>
                  {clusters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer">
                <input type="checkbox" name="autoDeployOnBuild" defaultChecked className="rounded accent-blue-600" />
                <span>Auto-deploy image on every successful push</span>
              </label>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Where Koala's leaves run
                </label>
                <select
                  name="executionTargetDeviceId"
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="">Sandboxed cluster (default)</option>
                  {localAgents.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}{d.online ? '' : ' (offline)'}</option>
                  ))}
                </select>
                {localAgents.length === 0 && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    No machines registered yet — add one under My Machines to run leaves locally instead.
                  </p>
                )}
              </div>

              <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer">
                <input type="checkbox" name="requireApproval" defaultChecked className="rounded accent-blue-600" />
                <span>Require my approval before each command on a local machine</span>
              </label>

              {createProject.isError && (
                <p className="text-rose-400 text-xs">
                  {(createProject.error as any)?.response?.data?.error || 'Failed to create project'}
                </p>
              )}

              <div className="flex gap-2.5 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 bg-[var(--bark-800)] hover:bg-[var(--bark-700)] text-slate-200 py-2 rounded-md font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createProject.isPending}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded-md font-medium transition-colors"
                >
                  {createProject.isPending ? 'Registering...' : 'Register Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {logRunId && <PipelineLogModal runId={logRunId} onClose={() => setLogRunId(null)} />}
    </div>
  );
}
