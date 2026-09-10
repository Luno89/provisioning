import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Check, X } from 'lucide-react';
import {
  listPendingApprovals, decideApproval, pendingApprovalKeys, type PendingApproval,
} from '../api/pending-approvals';

export function PendingApprovals() {
  const qc = useQueryClient();

  const { data: approvals = [] } = useQuery<PendingApproval[]>({
    queryKey: pendingApprovalKeys.list(),
    queryFn: listPendingApprovals,
    refetchInterval: 3000,
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'denied' }) => decideApproval(id, decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: pendingApprovalKeys.list() }),
  });

  if (approvals.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[70] space-y-3 w-full max-w-sm">
      {approvals.map((a) => (
        <div key={a.id} className="bg-slate-900 border border-amber-500/40 rounded-lg shadow-2xl p-4 animate-in slide-in-from-bottom">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert size={16} className="text-amber-400 shrink-0" />
            <span className="text-xs font-bold text-amber-300">A leaf wants to run this on your machine</span>
          </div>
          <pre className="text-[11px] font-mono text-slate-300 bg-black/40 rounded-md p-2.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words mb-3">
            {a.command}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => decide.mutate({ id: a.id, decision: 'denied' })}
              disabled={decide.isPending}
              className="flex-1 flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold py-2 rounded-md transition-colors"
            >
              <X size={13} /> Deny
            </button>
            <button
              onClick={() => decide.mutate({ id: a.id, decision: 'approved' })}
              disabled={decide.isPending}
              className="flex-1 flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold py-2 rounded-md transition-colors"
            >
              <Check size={13} /> Approve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default PendingApprovals;
