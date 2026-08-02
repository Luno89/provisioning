import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Plus, Loader2, Trash2, ChevronRight, ChevronDown, CircleSlash, Link2, Unlink } from 'lucide-react';

/**
 * The board — agent harness Phase B.
 *
 * Each card in an active column is backed by a Temporal workflow, so moving a card is a signal
 * rather than a database mutation with a job loosely attached. That is why a card with sub-items
 * cannot be dragged directly: its state is DERIVED from its children, and the server refuses the
 * move rather than letting the board disagree with the workflow.
 *
 * No personas act on cards yet — a card's "work" is currently waiting for a human to move it.
 * Deliberately so: it exercises durability, fan-out and cancellation before agents depend on them.
 */

// Work states only. No Backlog (a card exists because a request needed it) and no Done
// (completion is `status`, and two sources of truth for it drift).
const COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
] as const;

type ColumnId = (typeof COLUMNS)[number]['id'];

interface Card {
  id: string;
  title: string;
  body?: string;
  column: ColumnId;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  parentCardId?: string;
  depth: number;
  blocking: boolean;
  childCount: number;
  workflowId?: string;
  budget?: { maxTokens?: number; maxWorkspaces?: number; maxReplans?: number };
}

const STATUS_STYLE: Record<Card['status'], string> = {
  pending: 'text-slate-500',
  running: 'text-blue-400',
  succeeded: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-slate-600 line-through',
};

export default function Board({ apiBase }: { apiBase: string }) {
  const qc = useQueryClient();
  const [newTitle, setNewTitle] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null);
  const [childTitle, setChildTitle] = useState('');
  const [childBlocking, setChildBlocking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: cards, isLoading } = useQuery<Card[]>({
    queryKey: ['cards'],
    queryFn: () => axios.get(`${apiBase}/cards`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 5000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cards'] });
  // The server's refusals carry the reason (depth cap, fan-out cap, "move the sub-items instead").
  // Surfacing them beats a generic failure, since each one tells the user what to do differently.
  const onError = (e: any) => setError(e?.response?.data?.error ?? e.message);

  const createCard = useMutation({
    mutationFn: (body: any) => axios.post(`${apiBase}/cards`, body, { withCredentials: true }),
    onSuccess: () => { setNewTitle(''); setChildTitle(''); setAddingChildTo(null); setError(null); invalidate(); },
    onError,
  });
  const moveCard = useMutation({
    mutationFn: ({ id, column }: { id: string; column: ColumnId }) =>
      axios.patch(`${apiBase}/cards/${id}`, { column }, { withCredentials: true }),
    onSuccess: () => { setError(null); invalidate(); },
    onError,
  });
  const cancelCard = useMutation({
    mutationFn: (id: string) => axios.post(`${apiBase}/cards/${id}/cancel`, {}, { withCredentials: true }),
    onSuccess: () => invalidate(),
    onError,
  });
  const deleteCard = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/cards/${id}`, { withCredentials: true }),
    onSuccess: () => invalidate(),
    onError,
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 text-slate-400 p-8"><Loader2 className="animate-spin" size={16} /> Loading board…</div>;
  }

  const all = cards ?? [];
  const roots = all.filter((c) => !c.parentCardId);
  const childrenOf = (id: string) => all.filter((c) => c.parentCardId === id);

  const renderCard = (card: Card, nested = false) => {
    const kids = childrenOf(card.id);
    const isOpen = expanded[card.id] ?? false;
    const derived = kids.length > 0;

    return (
      <div key={card.id} className={`rounded-xl border ${nested ? 'border-slate-800 bg-slate-950' : 'border-slate-800 bg-slate-900'} p-3`}>
        <div className="flex items-start gap-2">
          {kids.length > 0 && (
            <button onClick={() => setExpanded((e) => ({ ...e, [card.id]: !isOpen }))} className="text-slate-500 hover:text-slate-300 mt-0.5">
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-200 break-words">{card.title}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className={`text-[10px] uppercase tracking-widest ${STATUS_STYLE[card.status]}`}>{card.status}</span>
              {derived && <span className="text-[10px] text-slate-600">derived from {kids.length}</span>}
              {nested && (
                <span className="text-[10px] text-slate-600 flex items-center gap-1" title={card.blocking ? 'Parent waits for this' : 'Outlives its parent'}>
                  {card.blocking ? <Link2 size={10} /> : <Unlink size={10} />}
                  {card.blocking ? 'blocking' : 'detached'}
                </span>
              )}
              {card.budget && <span className="text-[10px] text-slate-600">budgeted</span>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {card.status === 'running' && (
              <button onClick={() => cancelCard.mutate(card.id)} title="Cancel" className="text-slate-600 hover:text-amber-400"><CircleSlash size={13} /></button>
            )}
            <button onClick={() => deleteCard.mutate(card.id)} title="Delete (and its sub-items)" className="text-slate-600 hover:text-red-400"><Trash2 size={13} /></button>
          </div>
        </div>

        {/* Moving is disabled for a card with children: the server derives its state from them and
            refuses the change, so offering the control would only produce an error. */}
        {!derived && (
          <select
            value={card.column}
            onChange={(e) => moveCard.mutate({ id: card.id, column: e.target.value as ColumnId })}
            className="mt-2 w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-400 focus:border-blue-500 focus:outline-none"
          >
            {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        )}

        {card.depth < 3 && (
          addingChildTo === card.id ? (
            <div className="mt-2 space-y-2">
              <input
                autoFocus
                value={childTitle}
                onChange={(e) => setChildTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && childTitle.trim()) {
                    createCard.mutate({ title: childTitle, parentCardId: card.id, blocking: childBlocking, column: 'todo' });
                  }
                  if (e.key === 'Escape') setAddingChildTo(null);
                }}
                placeholder="Sub-item title…"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[12px] focus:border-blue-500 focus:outline-none"
              />
              <label className="flex items-center gap-2 text-[11px] text-slate-500">
                <input type="checkbox" checked={childBlocking} onChange={(e) => setChildBlocking(e.target.checked)} />
                Parent waits for this
              </label>
            </div>
          ) : (
            <button onClick={() => { setAddingChildTo(card.id); setChildTitle(''); setChildBlocking(true); }}
              className="mt-2 text-[11px] text-slate-600 hover:text-slate-400 flex items-center gap-1">
              <Plus size={11} /> Sub-item
            </button>
          )
        )}

        {isOpen && kids.length > 0 && (
          <div className="mt-2 space-y-2 pl-3 border-l border-slate-800">{kids.map((k) => renderCard(k, true))}</div>
        )}
      </div>
    );
  };

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-3xl font-bold">Board</h2>
        <p className="text-slate-400 text-sm">Each card is backed by a durable workflow — it survives a restart.</p>
      </header>

      <div className="flex gap-3 mb-6 max-w-2xl">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newTitle.trim()) createCard.mutate({ title: newTitle, column: 'todo' }); }}
          placeholder="New card…"
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={() => createCard.mutate({ title: newTitle, column: 'todo' })}
          disabled={!newTitle.trim() || createCard.isPending}
          className="px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center gap-2 text-sm"
        >
          {createCard.isPending ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} Add
        </button>
      </div>

      {error && (
        <div className="mb-4 text-sm text-amber-300 bg-amber-950/30 border border-amber-900 rounded-xl px-4 py-3 max-w-2xl">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          const inColumn = roots.filter((c) => c.column === col.id);
          return (
            <div key={col.id} className="min-w-0">
              <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                {col.label} <span className="text-slate-700">{inColumn.length}</span>
              </h3>
              <div className="space-y-2">
                {inColumn.map((c) => renderCard(c))}
                {inColumn.length === 0 && <p className="text-[11px] text-slate-700">—</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
