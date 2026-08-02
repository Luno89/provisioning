import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, GitBranch } from 'lucide-react';
import Chat from './Chat.js';
import Board from './Board.js';

/**
 * Chat and board together — the harness's main surface.
 *
 * The two are deliberately NOT bound to each other. A branch is one planning conversation, and the
 * board visualises how that work decomposed, but you can also just talk: chat mode has no branch
 * and produces nothing. Tying them would mean every idle question grew a tree.
 *
 * Modes:
 *   chat — ordinary conversation, no side effects.
 *   plan — the reply may propose leaves, which appear alongside as Sprouting for you to accept.
 *
 * The agent is the primary author of leaves; the board stays editable because a plan you cannot
 * correct is a plan you have to argue with.
 */
export default function Workspace({ apiBase }: { apiBase: string }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'chat' | 'plan'>('chat');
  // One branch per planning session, created on entering plan mode rather than per message —
  // a branch is the conversation, so every turn in it grows the same tree.
  const [branchId, setBranchId] = useState<string>(() => crypto.randomUUID());

  const enterPlan = () => {
    setMode('plan');
  };

  const newBranch = () => {
    setBranchId(crypto.randomUUID());
    qc.invalidateQueries({ queryKey: ['leaves'] });
  };

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-[calc(100vh-7rem)]">
      <div className="xl:w-[46%] min-w-0 flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex rounded-xl bg-slate-900 border border-slate-800 p-0.5">
            <button
              onClick={() => setMode('chat')}
              className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-colors ${mode === 'chat' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <MessageSquare size={13} /> Chat
            </button>
            <button
              onClick={enterPlan}
              className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-colors ${mode === 'plan' ? 'bg-emerald-700 text-emerald-50' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <GitBranch size={13} /> Plan
            </button>
          </div>
          {mode === 'plan' && (
            <button onClick={newBranch} className="text-[11px] text-slate-500 hover:text-slate-300">
              New branch
            </button>
          )}
          <span className="text-[11px] text-slate-600 ml-auto">
            {mode === 'plan' ? 'Replies may propose leaves' : 'No side effects'}
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <Chat
            apiBase={apiBase}
            mode={mode}
            // Only in plan mode: a chat with no branch cannot grow anything, which is the point.
            {...(mode === 'plan' ? { branchId } : {})}
            onProposals={() => qc.invalidateQueries({ queryKey: ['leaves'] })}
          />
        </div>
      </div>

      <div className="xl:w-[54%] min-w-0 overflow-y-auto border-t xl:border-t-0 xl:border-l border-slate-800 xl:pl-6 pt-6 xl:pt-0">
        <Board apiBase={apiBase} />
      </div>
    </div>
  );
}
