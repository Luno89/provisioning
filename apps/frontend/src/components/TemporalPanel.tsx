import { useState } from 'react';
import {
  cancelWorkflow, getTemporalStatus, getWorkflowCount, listWorkflows, getWorkflow, temporalKeys,
  type WorkflowScope, type WorkflowSummary,
} from '../api/temporal';
import { errorMessage } from '../api/client';
import { useShellStore } from '../stores/shell';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle, XCircle, Timer, Loader2, ChevronDown, ChevronUp, Server, Hash, Play, Ban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  RUNNING: 'bg-green-500/10 text-green-500',
  COMPLETED: 'bg-blue-500/10 text-blue-500',
  FAILED: 'bg-red-500/10 text-red-500',
  TIMED_OUT: 'bg-yellow-500/10 text-yellow-500',
  CANCELLED: 'bg-slate-500/10 text-slate-400',
  TERMINATED: 'bg-red-500/10 text-red-500',
};

const STATUS_ICONS: Record<string, LucideIcon> = {
  RUNNING: Play,
  COMPLETED: CheckCircle,
  FAILED: XCircle,
  TIMED_OUT: Timer,
};

function statusBadge(status: string | undefined) {
  const color = STATUS_COLORS[status || ''] || 'bg-slate-500/10 text-slate-400';
  const Icon = STATUS_ICONS[status || ''];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-3 py-1 rounded-full uppercase ${color}`}>
      {Icon && <Icon size={12} />}
      {status || 'UNKNOWN'}
    </span>
  );
}

function fmtTime(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtDuration(start: string | undefined, end: string | undefined) {
  if (!start) return '—';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function CancelWorkflow({ workflowId }: { workflowId: string }) {
  const [confirming, setConfirming] = useState(false);
  const client = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelWorkflow(workflowId),
    onSuccess: () => {
      setConfirming(false);
      for (const key of [temporalKeys.everyList(), temporalKeys.everyCount(), temporalKeys.workflow(workflowId)]) void client.invalidateQueries({ queryKey: key });
    },
  });

  if (cancel.isSuccess) return <p className="text-xs text-slate-400">Cancel requested — it runs its own ending, then closes.</p>;
  return (
    <div className="flex flex-col items-end gap-2">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/10"
        >
          <Ban size={13} /> Cancel workflow
        </button>
      ) : (
        <div className="flex flex-col items-end gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <p className="max-w-xs text-right text-xs text-slate-300">
            Cancel <span className="font-mono">{workflowId}</span>? It stops what it is doing and runs its own ending. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
              Keep it running
            </button>
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {cancel.isPending ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />} Yes, cancel it
            </button>
          </div>
        </div>
      )}
      {cancel.isError && <p className="text-xs text-red-400">{errorMessage(cancel.error)}</p>}
    </div>
  );
}

function ownerLabel(owner: string | undefined, me: string | undefined) {
  if (!owner) return 'not recorded — started before owners were';
  if (owner === me) return 'you';
  if (owner === 'platform') return 'the platform';
  return owner;
}

export default function TemporalPanel() {
  const me = useShellStore((s) => s.user?.id);
  const [scope, setScope] = useState<WorkflowScope | undefined>(undefined);
  const [expandedWf, setExpandedWf] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: temporalKeys.status(),
    queryFn: getTemporalStatus,
    refetchInterval: 10000,
  });

  const { data: counts } = useQuery({
    queryKey: temporalKeys.workflowCount(scope),
    queryFn: () => getWorkflowCount(scope),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });

  const { data: workflowsData, isLoading } = useQuery({
    queryKey: temporalKeys.workflows(scope),
    queryFn: () => listWorkflows(50, scope),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });

  const { data: wfDetail, isFetching: detailLoading } = useQuery({
    queryKey: temporalKeys.workflow(expandedWf ?? ''),
    queryFn: () => (expandedWf ? getWorkflow(expandedWf) : null),
    enabled: !!expandedWf,
  });

  const workflows: WorkflowSummary[] = workflowsData?.workflows ?? [];
  const canSeeAll = workflowsData?.canSeeAll === true;
  const showing: WorkflowScope = scope ?? (workflowsData?.all ? 'all' : 'mine');

  const summaryCards = [
    {
      label: 'Running',
      value: counts?.running ?? '—',
      icon: Play,
      color: 'text-green-500 bg-green-500/10',
    },
    {
      label: 'Completed',
      value: counts?.completed ?? '—',
      icon: CheckCircle,
      color: 'text-blue-500 bg-blue-500/10',
    },
    {
      label: 'Failed',
      value: counts?.failed ?? '—',
      icon: XCircle,
      color: 'text-red-500 bg-red-500/10',
    },
    {
      label: 'Timed Out',
      value: counts?.timedOut ?? '—',
      icon: Timer,
      color: 'text-yellow-500 bg-yellow-500/10',
    },
    {
      label: 'Total',
      value: counts?.total ?? '—',
      icon: Hash,
      color: 'text-slate-300 bg-slate-700/50',
    },
  ];

  return (
    <section className="animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-6xl">
      <header className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-3xl font-bold">Temporal Workflows</h2>
          <p className="text-slate-400">{showing === 'all' ? 'Every workflow on this platform, yours and everyone else\'s.' : 'The workflows started for you: your runs, deploys, machines and checks.'}</p>
        </div>
        <div className="flex items-center gap-3">
          {canSeeAll && (
            <div className="flex rounded-xl bg-slate-800 p-1 text-xs" role="group" aria-label="Whose workflows">
              {(['mine', 'all'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={showing === choice}
                  onClick={() => { setScope(choice); setExpandedWf(null); }}
                  className={`rounded-lg px-3 py-1.5 font-medium ${showing === choice ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {choice === 'mine' ? 'Mine' : 'Everything'}
                </button>
              ))}
            </div>
          )}
          <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium ${status?.connected ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${status?.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {status?.connected ? 'Connected' : 'Disconnected'}
          </div>
          {status?.serverVersion && (
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 rounded-xl text-xs text-slate-400">
              <Server size={14} /> v{status.serverVersion}
            </div>
          )}
        </div>
      </header>

      <div className="grid grid-cols-5 gap-4 mb-8">
        {summaryCards.map(card => (
          <div key={card.label} className="bg-slate-800 rounded-2xl border border-slate-700 p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className={`p-2 rounded-xl ${card.color}`}>
                <card.icon size={18} />
              </div>
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{card.label}</span>
            </div>
            <div className="text-3xl font-bold">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
        <div className="p-5 border-b border-slate-700 flex justify-between items-center">
          <h3 className="font-bold flex items-center gap-2"><Activity size={16} className="text-blue-500" /> Recent Workflows</h3>
          <span className="text-[10px] text-slate-500 font-mono">{workflows.length} executions</span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-slate-600" size={32} /></div>
        ) : workflows.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            <Activity size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium mb-1">No workflow executions found</p>
            <p className="text-xs">Workflows appear here once Temporal processes them.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-700/50">
            <div className="grid grid-cols-[1fr_2fr_120px_180px_180px_100px] gap-4 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">
              <span>Type</span>
              <span>Workflow ID</span>
              <span>Status</span>
              <span>Started</span>
              <span>Duration</span>
              <span></span>
            </div>

            {workflows.map((wf) => {
              const isExpanded = expandedWf === wf.workflowId;
              return (
                <div key={wf.workflowId}>
                  <button
                    onClick={() => setExpandedWf(isExpanded ? null : wf.workflowId)}
                    className="w-full grid grid-cols-[1fr_2fr_120px_180px_180px_100px] gap-4 px-5 py-3 text-sm hover:bg-slate-700/30 transition-colors text-left items-center"
                  >
                    <span className="font-mono text-xs text-slate-300 truncate">{wf.type}</span>
                    <span className="font-mono text-xs text-slate-400 truncate">{wf.workflowId}</span>
                    <span>{statusBadge(wf.status)}</span>
                    <span className="text-xs text-slate-400">{fmtTime(wf.startTime)}</span>
                    <span className="text-xs text-slate-400">{fmtDuration(wf.startTime, wf.closeTime)}</span>
                    <span className="flex justify-end text-slate-500">
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="px-5 py-4 bg-slate-900/50 border-t border-slate-700/50 animate-in fade-in slide-in-from-top-2 duration-200">
                      {detailLoading ? (
                        <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="animate-spin" size={16} /> Loading details...</div>
                      ) : wfDetail ? (
                        <div className="grid grid-cols-2 gap-6">
                          <div>
                            <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Workflow Info</h4>
                            <div className="space-y-1.5 text-xs">
                              <div className="flex justify-between"><span className="text-slate-500">Owner</span><span className="font-mono text-slate-300 truncate ml-4">{ownerLabel(wfDetail.owner, me)}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Run ID</span><span className="font-mono text-slate-300 truncate ml-4">{wfDetail.runId}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Task Queue</span><span className="font-mono text-slate-300">{wfDetail.taskQueue}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">History Length</span><span className="font-mono text-slate-300">{wfDetail.historyLength}</span></div>
                              {wfDetail.closeTime && (
                                <div className="flex justify-between"><span className="text-slate-500">Closed</span><span className="text-slate-300">{fmtTime(wfDetail.closeTime)}</span></div>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-3 text-right">
                            <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium ${statusBadge(wfDetail.status).props.className}`}>
                              {statusBadge(wfDetail.status)}
                            </span>
                            {(canSeeAll || (me !== undefined && wfDetail.owner === me)) && wfDetail.status === 'RUNNING' && <CancelWorkflow key={wfDetail.workflowId} workflowId={wfDetail.workflowId} />}
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">Could not load workflow details.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
