import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import Chat from './Chat.js';
import Board from './Board.js';

/**
 * Chat and board together — the harness's main surface.
 *
 * There is NO plan mode. Proposing is an ability the model always has and exercises when it is
 * confident, so a conversation can drift between chatting and planning without anyone declaring
 * intent up front. A toggle would persist, be forgotten, and be wrong exactly when it mattered.
 *
 * That is safe because it was measured rather than assumed: against the live model, a greeting, a
 * general opinion question, a factual question and a vague complaint all produced no proposals,
 * while a concrete request produced one. And a false positive costs a dismissal — a proposed leaf
 * starts no workflow and spends nothing until accepted.
 *
 * `/plan` remains for when you want to force it and the model would have declined.
 */
export default function Workspace({ apiBase }: { apiBase: string }) {
  const qc = useQueryClient();
  // A branch is the conversation, so every turn grows the same tree. "New branch" starts a fresh
  // one rather than a mode being switched.
  const [branchId, setBranchId] = useState<string>(() => crypto.randomUUID());

  const refreshLeaves = () => qc.invalidateQueries({ queryKey: ['leaves'] });

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-[calc(100vh-7rem)]">
      <div className="xl:w-[46%] min-w-0 flex flex-col">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <Sparkles size={12} className="text-emerald-500" />
            Ask anything — type <span className="font-mono text-slate-400">/plan</span> to insist on a breakdown
          </span>
          <button
            onClick={() => { setBranchId(crypto.randomUUID()); refreshLeaves(); }}
            className="ml-auto text-[11px] text-slate-500 hover:text-slate-300"
          >
            New branch
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* branchId is always passed: any reply may propose, so there is always somewhere for
              proposals to land. */}
          <Chat apiBase={apiBase} branchId={branchId} onProposals={refreshLeaves} />
        </div>
      </div>

      <div className="xl:w-[54%] min-w-0 overflow-y-auto border-t xl:border-t-0 xl:border-l border-slate-800 xl:pl-6 pt-6 xl:pt-0">
        <Board apiBase={apiBase} />
      </div>
    </div>
  );
}
