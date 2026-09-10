import { Clock, Loader2, CheckCircle2, XCircle, Terminal, Rocket } from 'lucide-react';

export interface PipelineRun {
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
  commitMessage?: string;
  promotedAt?: string;
  deploymentId?: string;
}

const STATUS_STYLE: Record<string, { icon: any; className: string; label: string }> = {
  queued: { icon: Clock, className: 'text-slate-400 bg-slate-500/10 border-slate-500/20', label: 'Queued' },
  running: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'Building' },
  succeeded: { icon: CheckCircle2, className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', label: 'Succeeded' },
  failed: { icon: XCircle, className: 'text-rose-400 bg-rose-500/10 border-rose-500/20', label: 'Failed' },
};

export function StatusBadge({ status }: { status?: string | undefined }) {
  const s = STATUS_STYLE[status || 'queued'] ?? STATUS_STYLE.queued!;
  const Icon = s.icon;
  return (
    <span className={`text-[11px] font-medium font-mono px-2 py-0.5 rounded-md border flex items-center gap-1.5 w-fit ${s.className}`}>
      <Icon size={12} className={status === 'running' ? 'animate-spin' : ''} /> {s.label}
    </span>
  );
}

export function PipelineRunRow({
  run, isLive, onViewLogs, onPromote, promoting,
}: {
  run: PipelineRun;
  isLive?: boolean;
  onViewLogs: (runId: string) => void;
  onPromote?: (run: PipelineRun) => void;
  promoting?: boolean;
}) {
  const commitMessage = run.commitMessage?.split('\n')[0];
  return (
    <div className="rounded-md border border-[var(--bark-800)] bg-[var(--bark-950)]/70 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono text-xs">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2.5 flex-wrap">
          <StatusBadge status={run.status} />
          {isLive && (
            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
              ● Live
            </span>
          )}
          <span className="text-slate-300 font-bold">{run.commitSha.slice(0, 8)}</span>
          <span className="text-slate-400 text-[11px] bg-[var(--bark-800)] px-1.5 py-0.5 rounded">{run.ref}</span>
          {run.imageTag && (
            <span className="text-slate-400 text-[11px] truncate max-w-xs" title={run.imageTag}>
              tag: <span className="text-blue-300">{run.imageTag.split(':').pop()}</span>
            </span>
          )}
        </div>
        {commitMessage && (
          <div className="text-[11px] text-slate-300 truncate" title={run.commitMessage}>{commitMessage}</div>
        )}
        <div className="text-[11px] text-slate-400">
          Started {new Date(run.startedAt).toLocaleString()}
          {run.finishedAt && ` • Finished in ${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`}
        </div>
        {run.errorMessage && (
          <div className="text-[11px] text-rose-400 truncate">{run.errorMessage}</div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
        <button
          onClick={() => onViewLogs(run.id)}
          className="text-slate-300 hover:text-white bg-[var(--bark-800)] hover:bg-[var(--bark-700)] text-[11px] px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors"
        >
          <Terminal size={12} /> Build Logs
        </button>
        {onPromote && run.status === 'succeeded' && run.imageTag && (
          <button
            onClick={() => onPromote(run)}
            disabled={promoting}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors"
          >
            <Rocket size={12} /> Deploy
          </button>
        )}
      </div>
    </div>
  );
}
