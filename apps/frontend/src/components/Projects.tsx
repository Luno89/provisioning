import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { GitBranch, Plus, X, Loader2, CheckCircle2, XCircle, Clock, Rocket, RefreshCw, AlertTriangle } from 'lucide-react';
import { AnsiText } from './AnsiText.js';

interface Project {
  id: string;
  name: string;
  giteaOwner: string;
  giteaRepo: string;
  targetClusterId?: string;
  targetNamespace?: string;
  appType: string;
  autoDeployOnBuild?: boolean;
  lastBuildStatus?: 'queued' | 'running' | 'succeeded' | 'failed';
  /** End-to-end rollup from the server — see lib/project-status.ts. Worst state in the chain wins. */
  status?: 'no-build' | 'building' | 'build-failed' | 'built' | 'deploying' | 'deploy-failed' | 'unhealthy' | 'running';
  /** Why, for the states that need explaining: a build error, or the pod's health reason. */
  reason?: string;
  createdAt: string;
}

interface PipelineRun {
  id: string;
  projectId: string;
  commitSha: string;
  ref: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  imageTag?: string;
  logFile?: string;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

interface Cluster {
  id: string;
  name: string;
}

const STATUS_STYLE: Record<string, { icon: any; className: string }> = {
  queued: { icon: Clock, className: 'text-slate-400 bg-slate-500/10' },
  running: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 animate-pulse' },
  succeeded: { icon: CheckCircle2, className: 'text-green-400 bg-green-500/10' },
  failed: { icon: XCircle, className: 'text-red-400 bg-red-500/10' },
};

function StatusBadge({ status }: { status?: string }) {
  const s = STATUS_STYLE[status || 'queued'] || STATUS_STYLE.queued;
  const Icon = s.icon;
  return (
    <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase flex items-center gap-1.5 w-fit ${s.className}`}>
      <Icon size={12} className={status === 'running' ? 'animate-spin' : ''} /> {status || 'queued'}
    </span>
  );
}

/**
 * The project's end-to-end state, not just its build's.
 *
 * The card used to show `lastBuildStatus`, which answers "did the image get made" — and was being
 * read as "does this work". A project could sit there green while the pod running its image had
 * been in CrashLoopBackOff for an hour.
 *
 * The rollup is computed on the server (lib/project-status.ts) so this and the branch view cannot
 * disagree about what healthy means. Worst state wins, so green here is trustworthy.
 *
 * `unhealthy` is amber rather than red for the same reason it is on a deployment: the build and
 * the deploy both worked, and sending someone to the build log would waste their time.
 */
const PROJECT_STATUS: Record<string, { icon: any; className: string; label: string }> = {
  'no-build': { icon: Clock, className: 'text-slate-400 bg-slate-500/10', label: 'no build yet' },
  building: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10', label: 'building' },
  'build-failed': { icon: XCircle, className: 'text-red-400 bg-red-500/10', label: 'build failed' },
  built: { icon: CheckCircle2, className: 'text-slate-300 bg-slate-500/10', label: 'built, not deployed' },
  deploying: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10', label: 'deploying' },
  'deploy-failed': { icon: XCircle, className: 'text-red-400 bg-red-500/10', label: 'deploy failed' },
  unhealthy: { icon: AlertTriangle, className: 'text-amber-400 bg-amber-500/10', label: 'not running' },
  running: { icon: CheckCircle2, className: 'text-green-400 bg-green-500/10', label: 'running' },
};

function ProjectStatusBadge({ status, reason }: { status?: string; reason?: string }) {
  const s = PROJECT_STATUS[status || 'no-build'] || PROJECT_STATUS['no-build']!;
  const Icon = s.icon;
  const spinning = status === 'building' || status === 'deploying';
  return (
    <span
      title={reason || undefined}
      className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase flex items-center gap-1.5 w-fit ${s.className}`}
    >
      <Icon size={12} className={spinning ? 'animate-spin' : ''} /> {s.label}
    </span>
  );
}

export default function Projects({ apiBase, socketUrl, clusters }: { apiBase: string; socketUrl: string; clusters: Cluster[] }) {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [logRunId, setLogRunId] = useState<string | null>(null);
  const [socketLogs, setSocketLogs] = useState('');
  const socketRef = useRef<Socket | null>(null);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => axios.get(`${apiBase}/projects`, { withCredentials: true }).then(res => res.data),
    refetchInterval: 5000,
  });

  const { data: runs = [] } = useQuery<PipelineRun[]>({
    queryKey: ['project-runs', expandedProject],
    queryFn: () => axios.get(`${apiBase}/projects/${expandedProject}/runs`, { withCredentials: true }).then(res => res.data),
    enabled: !!expandedProject,
    refetchInterval: (query) => (query.state.data || []).some(r => r.status === 'queued' || r.status === 'running') ? 3000 : false,
  });

  const createProject = useMutation({
    mutationFn: (payload: any) => axios.post(`${apiBase}/projects`, payload, { withCredentials: true }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['projects'] }); setShowCreateModal(false); },
  });

  const promoteRun = useMutation({
    mutationFn: ({ projectId, runId }: { projectId: string; runId: string }) =>
      axios.post(`${apiBase}/projects/${projectId}/runs/${runId}/promote`, {}, { withCredentials: true }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['deployments'] }); },
  });

  const { data: initialLog } = useQuery({
    queryKey: ['logs', 'pipeline', logRunId],
    queryFn: () => axios.get(`${apiBase}/logs/pipeline/${logRunId}`, { withCredentials: true }).then(res => res.data),
    enabled: !!logRunId,
  });

  useEffect(() => {
    // See App.tsx: the socket handshake is authenticated by the session cookie now.
    const socket = io(socketUrl, { withCredentials: true });
    socketRef.current = socket;
    return () => { socket.disconnect(); };
  }, [socketUrl]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !logRunId) return;
    setSocketLogs('');
    socket.emit('join-room', logRunId);
    socket.on('log', (chunk: string) => setSocketLogs(prev => prev + chunk));
    return () => {
      socket.emit('leave-room', logRunId);
      socket.off('log');
    };
  }, [logRunId]);

  /**
   * Refresh when a deployment changes, rather than only every 5s.
   *
   * The project rollup now depends on deployment health, which the background reconciler can flip
   * to `unhealthy` at any moment — this card was previously deaf to that event and only ever
   * listened for build logs, so a pod that died showed up whenever the poll happened to land.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const onChange = () => queryClient.invalidateQueries({ queryKey: ['projects'] });
    socket.on('deployment-updated', onChange);
    return () => { socket.off('deployment-updated', onChange); };
  }, [queryClient]);

  return (
    <section>
      <header className="flex justify-between items-center mb-10">
        <div>
          <h2 className="text-3xl font-bold">Projects</h2>
          <p className="text-slate-400">Sibling repos hosted on the self-hosted Gitea instance — push to build, promote to deploy.</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105">
          <Plus size={20} /> New Project
        </button>
      </header>

      {isLoading ? (
        <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading projects...</div>
      ) : projects.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-3xl p-12 text-center max-w-2xl">
          <GitBranch className="mx-auto mb-4 text-slate-600" size={40} />
          <h3 className="text-xl font-bold mb-2">No projects yet</h3>
          <p className="text-slate-400 text-sm">Register a sibling repo to start building and deploying it through this platform.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 max-w-5xl">
          {projects.map(p => (
            <div key={p.id} className="bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden shadow-sm transition-all hover:border-slate-500">
              <div className="p-8">
                <div className="flex justify-between items-center mb-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><GitBranch size={28} /></div>
                    <div>
                      <h4 className="font-bold text-2xl">{p.name}</h4>
                      <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{p.giteaOwner}/{p.giteaRepo}{p.autoDeployOnBuild ? ' • auto-deploy on' : ''}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <ProjectStatusBadge status={p.status} reason={p.reason} />
                    <button
                      onClick={() => setExpandedProject(expandedProject === p.id ? null : p.id)}
                      className="text-slate-400 hover:text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-slate-700 transition-all flex items-center gap-2"
                    >
                      <RefreshCw size={14} /> {expandedProject === p.id ? 'Hide runs' : 'View runs'}
                    </button>
                  </div>
                </div>

                {expandedProject === p.id && (
                  <div className="mt-6 pt-6 border-t border-slate-700 space-y-3">
                    {runs.length === 0 ? (
                      <p className="text-slate-500 text-sm">No builds yet — push a commit to {p.giteaOwner}/{p.giteaRepo} to trigger one.</p>
                    ) : runs.map(r => (
                      <div key={r.id} className="bg-slate-900 border border-slate-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-3 mb-1">
                            <StatusBadge status={r.status} />
                            <span className="font-mono text-xs text-slate-400">{r.commitSha.slice(0, 8)}</span>
                            <span className="text-xs text-slate-500">{r.ref}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">{new Date(r.startedAt).toLocaleString()}</div>
                          {r.errorMessage && <div className="text-[11px] text-red-400 mt-1 truncate">{r.errorMessage}</div>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => setLogRunId(r.id)} className="text-slate-400 hover:text-white text-xs font-bold px-3 py-2 rounded-lg hover:bg-slate-700 transition-all">Logs</button>
                          {r.status === 'succeeded' && r.imageTag && (
                            <button
                              onClick={() => promoteRun.mutate({ projectId: p.id, runId: r.id })}
                              disabled={promoteRun.isPending}
                              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1.5 transition-all"
                            >
                              <Rocket size={14} /> Deploy this build
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Register Project</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white transition-colors" aria-label="Close"><X size={24} /></button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              createProject.mutate({
                name: d.get('name'),
                giteaRepo: d.get('giteaRepo'),
                createRepo: d.get('createRepo') === 'on',
                targetClusterId: d.get('targetClusterId') || undefined,
                targetNamespace: d.get('name'),
                autoDeployOnBuild: d.get('autoDeployOnBuild') === 'on',
              });
            }}>
              <div className="space-y-6">
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Project Name</label>
                  <input name="name" required className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 transition-all text-sm" placeholder="e.g. my-side-project" />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Gitea Repo Name</label>
                  <input name="giteaRepo" required className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 transition-all text-sm" placeholder="e.g. my-side-project" />
                </div>
                <label className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer">
                  <input type="checkbox" name="createRepo" defaultChecked className="w-4 h-4 accent-blue-600" />
                  Create a new empty repo (uncheck to point at one that already exists)
                </label>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Target Cluster (for deploys)</label>
                  <select name="targetClusterId" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm">
                    <option value="">Select a cluster...</option>
                    {clusters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer">
                  <input type="checkbox" name="autoDeployOnBuild" className="w-4 h-4 accent-blue-600" />
                  Auto-deploy every successful build (no manual promote click)
                </label>
                {createProject.isError && (
                  <p className="text-red-400 text-xs">{(createProject.error as any)?.response?.data?.error || 'Failed to create project'}</p>
                )}
              </div>
              <div className="flex gap-4 mt-10">
                <button type="button" onClick={() => setShowCreateModal(false)} className="flex-1 bg-slate-700 py-3 rounded-xl font-bold hover:bg-slate-600 transition-all text-sm">Cancel</button>
                <button type="submit" disabled={createProject.isPending} className="flex-1 bg-blue-600 disabled:opacity-50 py-3 rounded-xl font-bold shadow-lg shadow-blue-900/20 hover:bg-blue-500 transition-all text-sm">
                  {createProject.isPending ? 'Creating...' : 'Register Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {logRunId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="flex justify-between items-center p-6 border-b border-slate-700">
              <h3 className="text-xl font-bold flex items-center gap-2"><GitBranch size={18} /> Build Log</h3>
              <button onClick={() => setLogRunId(null)} className="text-slate-400 hover:text-white transition-colors" aria-label="Close"><X size={22} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-slate-950 font-mono text-xs custom-scrollbar">
              <AnsiText text={((initialLog?.content || '') + socketLogs) || 'Loading log...'} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
