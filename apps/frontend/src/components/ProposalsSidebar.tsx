import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, X, Inbox, Loader2, ShieldAlert, Key, Eye, EyeOff, Lock } from 'lucide-react';
import { ProposedTreeCard } from './Chat/ChatMessageRow.js';
import SpecProposal, { type Spec } from './SpecProposal.js';
import { getTreeBoard, groveKeys } from '../api/grove.js';
import type {
  ProposedTreeRecord, ProposedSpecRecord, ProposedEscalationRecord, ProposedSecretRequestRecord,
} from '../api/chat-pack.js';

/** Persisted wins over live — a proposal from the just-finished turn shouldn't render twice while the ephemeral stream state and the refetched conversation both still have it. */
function mergeById<T extends { id: string }>(live: readonly T[], persisted: readonly T[] | undefined): T[] {
  const byId = new Map<string, T>();
  for (const item of live) byId.set(item.id, item);
  for (const item of persisted ?? []) byId.set(item.id, item);
  return [...byId.values()];
}

export interface ProposalsSidebarProps {
  isOpen: boolean;
  onToggle: () => void;

  liveTrees: readonly ProposedTreeRecord[];
  persistedTrees: readonly ProposedTreeRecord[] | undefined;
  onAcceptTree: (id: string) => void;
  onDismissTree: (id: string) => void;
  treeActionPending: boolean;

  liveSpecs: readonly ProposedSpecRecord[];
  persistedSpecs: readonly ProposedSpecRecord[] | undefined;
  onAcceptSpec: (id: string) => void;
  onDismissSpec: (id: string) => void;
  specActionPending: boolean;

  liveEscalations: readonly ProposedEscalationRecord[];
  persistedEscalations: readonly ProposedEscalationRecord[] | undefined;
  onAcceptEscalation: (id: string) => void;
  onDenyEscalation: (id: string) => void;
  escalationActionPending: boolean;

  liveSecretRequests: readonly ProposedSecretRequestRecord[];
  persistedSecretRequests: readonly ProposedSecretRequestRecord[] | undefined;
  onSubmitSecret: (id: string, value: string) => void;
  onDismissSecret: (id: string) => void;
  secretActionPending: boolean;
}

/** Everything still waiting on the user, across all four proposal kinds — used for the toggle button's badge. */
export function pendingProposalsCount(props: Pick<ProposalsSidebarProps,
  'liveTrees' | 'persistedTrees' | 'liveSpecs' | 'persistedSpecs'
  | 'liveEscalations' | 'persistedEscalations' | 'liveSecretRequests' | 'persistedSecretRequests'>): number {
  const trees = mergeById(props.liveTrees, props.persistedTrees).filter((t) => !t.treeId && !t.dismissedAt);
  const specs = mergeById(props.liveSpecs, props.persistedSpecs).filter((s) => !s.acceptedAt && !s.dismissedAt);
  const escalations = mergeById(props.liveEscalations, props.persistedEscalations).filter((e) => e.status === 'pending');
  const secrets = mergeById(props.liveSecretRequests, props.persistedSecretRequests).filter((r) => r.status === 'pending');
  return trees.length + specs.length + escalations.length + secrets.length;
}

function AcceptedTreeProgress({ treeId, name }: { treeId: string; name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: groveKeys.board(treeId),
    queryFn: () => getTreeBoard(treeId),
    refetchInterval: 5000,
  });

  if (isLoading || !data) return null;
  if (data.rollup.outstanding === 0) return null;

  const { counts } = data.rollup;
  const parts = [
    counts.verified > 0 && `${counts.verified} verified`,
    counts.running > 0 && `${counts.running} running`,
    counts.claimed > 0 && `${counts.claimed} claimed`,
    counts.blocked > 0 && `${counts.blocked} blocked`,
    counts.failed > 0 && `${counts.failed} failed`,
    counts.proposed > 0 && `${counts.proposed} proposed`,
  ].filter(Boolean);

  return (
    <div className="mt-1.5 px-3 py-2 rounded-md bg-[var(--bark-900,#111814)] border border-[var(--bark-800,#1b2620)] text-[11px] text-slate-400 flex items-center gap-2">
      <Loader2 size={11} className="animate-spin text-emerald-400 shrink-0" />
      <span className="truncate">
        <span className="text-slate-300">{name}</span> — {parts.join(' · ') || 'settling…'}
      </span>
    </div>
  );
}

export function EscalationProposalCard({
  proposal,
  onAccept,
  onDeny,
  isPending,
}: {
  proposal: ProposedEscalationRecord;
  onAccept: (id: string) => void;
  onDeny: (id: string) => void;
  isPending?: boolean;
}) {
  return (
    <div className="p-3.5 rounded-lg border border-amber-500/30 bg-amber-950/20 text-slate-200 text-[13px] flex flex-col gap-2 my-2 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={15} className="text-amber-400 shrink-0" />
          <span className="font-semibold text-amber-200">Privilege Escalation Requested</span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
          {proposal.scope}
        </span>
      </div>
      <p className="text-slate-300 text-[12px] leading-relaxed">{proposal.reason}</p>
      {proposal.namespaces && proposal.namespaces.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span>Target Namespaces:</span>
          <div className="flex gap-1 flex-wrap font-mono">
            {proposal.namespaces.map((ns) => (
              <span key={ns} className="px-1.5 py-0.5 bg-black/40 rounded border border-slate-700 text-slate-300 text-[10px]">
                {ns}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 mt-1.5">
        <button
          type="button"
          onClick={() => onAccept(proposal.id)}
          disabled={isPending}
          className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-semibold transition-colors disabled:opacity-50 cursor-pointer"
        >
          Approve Escalation
        </button>
        <button
          type="button"
          onClick={() => onDeny(proposal.id)}
          disabled={isPending}
          className="px-3 py-1.5 rounded-md bg-[var(--bark-800,#1b2620)] hover:bg-[var(--bark-700,#24332b)] text-slate-300 text-[12px] transition-colors disabled:opacity-50 cursor-pointer"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function SecretRequestCard({
  request,
  onSubmit,
  onDismiss,
  isPending,
}: {
  request: ProposedSecretRequestRecord;
  onSubmit: (id: string, value: string) => void;
  onDismiss: (id: string) => void;
  isPending?: boolean;
}) {
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-slate-200 text-[13px] flex flex-col gap-2.5 my-2 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={15} className="text-emerald-400 shrink-0" />
          <span className="font-semibold text-emerald-200">
            {request.label || 'Secret Input Requested'}
          </span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          {request.key}
        </span>
      </div>

      <p className="text-slate-300 text-[12px] leading-relaxed">{request.description}</p>

      {request.projectId && (
        <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1">
          <span className="text-slate-500">Project:</span> {request.projectId}
        </div>
      )}

      <div className="flex flex-col gap-2 mt-1">
        <div className="relative flex items-center">
          <input
            type={showPassword ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Enter ${request.key}...`}
            className="w-full px-3 py-1.5 pr-9 rounded-md bg-black/50 border border-emerald-500/30 text-white font-mono text-xs focus:outline-none focus:border-emerald-400 placeholder:text-slate-500"
            disabled={isPending}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-2 text-slate-400 hover:text-slate-200 cursor-pointer p-1"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-slate-400 italic">
            Encrypted directly into Infisical vault; never stored in chat logs.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDismiss(request.id)}
              disabled={isPending}
              className="px-2.5 py-1 rounded bg-[var(--bark-800,#1b2620)] hover:bg-[var(--bark-700,#24332b)] text-slate-300 text-xs transition-colors disabled:opacity-50 cursor-pointer"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                if (value.trim()) onSubmit(request.id, value.trim());
              }}
              disabled={isPending || !value.trim()}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
            >
              <Lock size={12} />
              <span>Save to Vault</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProposalsSidebar(props: ProposalsSidebarProps) {
  if (!props.isOpen) return null;

  const pendingTrees = mergeById(props.liveTrees, props.persistedTrees).filter((t) => !t.treeId && !t.dismissedAt);
  const settlingTrees = mergeById(props.liveTrees, props.persistedTrees).filter((t) => t.treeId);
  const pendingSpecs = mergeById(props.liveSpecs, props.persistedSpecs).filter((s) => !s.acceptedAt && !s.dismissedAt);
  const pendingEscalations = mergeById(props.liveEscalations, props.persistedEscalations).filter((e) => e.status === 'pending');
  const pendingSecrets = mergeById(props.liveSecretRequests, props.persistedSecretRequests).filter((r) => r.status === 'pending');

  const nothingPending = pendingTrees.length === 0 && settlingTrees.length === 0
    && pendingSpecs.length === 0 && pendingEscalations.length === 0 && pendingSecrets.length === 0;

  return (
    <aside
      data-testid="proposals-sidebar-panel"
      className="w-72 sm:w-80 h-full flex-none flex flex-col bg-[var(--bark-950,#060908)] border-l border-[var(--bark-800,#1b2620)] select-none font-sans text-slate-300 z-20 transition-all"
    >
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-[var(--bark-800,#1b2620)] bg-[var(--bark-900,#0f1713)]">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <Inbox size={14} className="text-emerald-400" />
          <span>Proposals</span>
        </div>
        <button
          type="button"
          onClick={props.onToggle}
          className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-800,#1b2620)] transition-colors cursor-pointer"
          title="Collapse proposals"
          aria-label="Collapse proposals"
        >
          <ChevronRight size={16} className="hidden sm:block" />
          <X size={16} className="sm:hidden" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-4">
        {nothingPending && (
          <div className="text-center py-8 text-xs text-slate-500">Nothing pending</div>
        )}

        {pendingTrees.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider">Proposed Trees</div>
            {pendingTrees.map((p) => (
              <div key={p.id}>
                <ProposedTreeCard proposal={p} onAccept={props.onAcceptTree} isPending={props.treeActionPending} />
                <button
                  type="button"
                  onClick={() => props.onDismissTree(p.id)}
                  disabled={props.treeActionPending}
                  className="text-[11px] text-slate-500 hover:text-red-400 disabled:opacity-50 cursor-pointer -mt-1"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}

        {settlingTrees.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider">In Progress</div>
            {settlingTrees.map((p) => (
              <AcceptedTreeProgress key={p.id} treeId={p.treeId!} name={p.name} />
            ))}
          </div>
        )}

        {pendingSpecs.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider">Proposed App Specs</div>
            {pendingSpecs.map((p) => (
              <div key={p.id}>
                <SpecProposal
                  spec={p.spec as Spec}
                  accepted={Boolean(p.acceptedAt)}
                  pending={props.specActionPending}
                  onAccept={() => props.onAcceptSpec(p.id)}
                />
                <button
                  type="button"
                  onClick={() => props.onDismissSpec(p.id)}
                  disabled={props.specActionPending}
                  className="text-[11px] text-slate-500 hover:text-red-400 disabled:opacity-50 cursor-pointer mt-1"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}

        {pendingEscalations.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider">Privilege Escalations</div>
            {pendingEscalations.map((esc) => (
              <EscalationProposalCard
                key={esc.id}
                proposal={esc}
                onAccept={props.onAcceptEscalation}
                onDeny={props.onDenyEscalation}
                isPending={props.escalationActionPending}
              />
            ))}
          </div>
        )}

        {pendingSecrets.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider">Vaulted & Requested Secrets</div>
            {pendingSecrets.map((req) => (
              <SecretRequestCard
                key={req.id}
                request={req}
                onSubmit={props.onSubmitSecret}
                onDismiss={props.onDismissSecret}
                isPending={props.secretActionPending}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
