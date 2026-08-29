import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, Plus, Trash2, Edit3, Save, X, Lightbulb, Pin, ScrollText, Check, Globe, Folder, AlertCircle, ArrowUpRight } from 'lucide-react';
import { card } from './shared';
import {
  listMemories, getConsolidation, createMemory, updateMemory,
  approveMemory, promoteMemory, deleteMemory,
} from '../../api/harness';

interface MemoryItem {
  id: string;
  ownerId: string;
  projectId?: string;
  category: 'lessons_learned' | 'environment_facts' | 'prompt_guidance';
  scope?: 'project' | 'global';
  recommendedScope?: 'project' | 'global';
  status?: 'active' | 'pending_review';
  title: string;
  text: string;
  source?: 'manual' | 'agent_tool' | 'post_run_extractor';
  provenance?: {
    experimentId?: string;
    taskId?: string;
    toolId?: string;
  };
  createdAt: string;
  updatedAt: string;
  invalidAt?: string;
  supersededBy?: string;
  lastUsedAt?: string;
  useCount?: number;
}

interface ConsolidationReport {
  at: string;
  indexed: number;
  deduped: number;
  promoted: number;
  decayed: number;
  live: number;
}

const CATEGORY_META = {
  lessons_learned: { label: 'Lessons Learned', icon: Lightbulb, color: 'text-amber-400 border-amber-800 bg-amber-950/40' },
  environment_facts: { label: 'Environment Facts', icon: Pin, color: 'text-blue-400 border-blue-800 bg-blue-950/40' },
  prompt_guidance: { label: 'Prompt Guidance', icon: ScrollText, color: 'text-emerald-400 border-emerald-800 bg-emerald-950/40' },
};

export function MemoryBankPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('all');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [cat, setCat] = useState<'lessons_learned' | 'environment_facts' | 'prompt_guidance'>('lessons_learned');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  const { data: memories, isLoading } = useQuery<MemoryItem[]>({
    queryKey: ['harness-memories'],
    queryFn: listMemories,
  });

  const { data: consolidation } = useQuery<ConsolidationReport | null>({
    queryKey: ['harness-memory-consolidation'],
    queryFn: getConsolidation,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['harness-memories'] });

  const createMut = useMutation({
    mutationFn: () => createMemory({ category: cat, scope, title, text, status: 'active' }),
    onSuccess: () => {
      setAdding(false);
      setTitle('');
      setText('');
      invalidate();
    },
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => approveMemory(id),
    onSuccess: invalidate,
  });

  const promoteMut = useMutation({
    mutationFn: (id: string) => promoteMemory(id),
    onSuccess: invalidate,
  });

  const updateMut = useMutation({
    mutationFn: (item: { id: string; title: string; text: string; category: string; scope?: string }) =>
      updateMemory(item.id, item),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onSuccess: invalidate,
  });

  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setCat(m.category);
    setScope(m.scope || 'project');
    setTitle(m.title);
    setText(m.text);
  };

  const pendingList = (memories ?? []).filter((m) => m.status === 'pending_review' && !m.invalidAt);
  const retiredList = (memories ?? []).filter((m) => m.invalidAt);

  const activeList = (memories ?? []).filter((m) => {
    if (filter === 'retired') return Boolean(m.invalidAt);
    if (m.invalidAt) return false;
    if (filter === 'pending') return m.status === 'pending_review';
    if (filter === 'global') return (m.scope === 'global' || !m.scope) && m.status !== 'pending_review';
    if (filter === 'project') return m.scope === 'project' && m.status !== 'pending_review';
    return m.status !== 'pending_review';
  });

  const titleOf = (id?: string) => (memories ?? []).find((m) => m.id === id)?.title;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
            <Brain size={18} className="text-[var(--leaf-light)]" />
            Harness Memory Bank
          </h3>
          <p className="text-[12px] text-slate-400">
            Lessons, facts and prompt guidance, retrieved by relevance and admitted automatically.
            Superseded entries are retired rather than deleted, so nothing here is lost.
          </p>
        </div>
        <button
          onClick={() => { setAdding((a) => !a); setEditingId(null); setTitle(''); setText(''); }}
          className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
        >
          <Plus size={14} />
          Add Memory
        </button>
      </div>

      <div className="flex items-center gap-1 bg-[var(--bark-900)] p-1 rounded-lg border border-[var(--bark-600)]">
        {[
          { id: 'all', label: 'All Active' },
          ...(pendingList.length ? [{ id: 'pending', label: `Legacy Queue (${pendingList.length})` }] : []),
          { id: 'global', label: 'Global Memories' },
          { id: 'project', label: 'Project Memories' },
          ...(retiredList.length ? [{ id: 'retired', label: `Retired (${retiredList.length})` }] : []),
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={`text-[11px] px-3 py-1 rounded-md transition-colors ${
              filter === tab.id
                ? 'bg-[var(--leaf-stem)] text-white font-medium'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {consolidation && (consolidation.deduped > 0 || consolidation.decayed > 0 || consolidation.promoted > 0) && (
        <div className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl p-3 text-[11px] text-slate-400 flex items-center gap-2">
          <Brain size={13} className="text-[var(--leaf-light)] shrink-0" />
          <span>
            Last consolidation kept <strong className="text-slate-200">{consolidation.live}</strong> memories
            {consolidation.deduped > 0 && <> · retired <strong className="text-slate-200">{consolidation.deduped}</strong> duplicate(s)</>}
            {consolidation.decayed > 0 && <> · retired <strong className="text-slate-200">{consolidation.decayed}</strong> unused</>}
            {consolidation.promoted > 0 && <> · promoted <strong className="text-slate-200">{consolidation.promoted}</strong> finding(s)</>}
          </span>
        </div>
      )}

      {pendingList.length > 0 && filter !== 'pending' && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5 text-amber-300 text-xs">
            <AlertCircle size={16} className="shrink-0" />
            <span>
              <strong>{pendingList.length} memory item(s)</strong> are held over from the old review queue and
              have never reached a prompt. New memories no longer wait here — approve any of these that
              are still worth carrying, or leave them.
            </span>
          </div>
          <button
            onClick={() => setFilter('pending')}
            className="text-xs px-3 py-1 bg-amber-800/80 hover:bg-amber-700 text-amber-100 rounded-md font-medium"
          >
            Open
          </button>
        </div>
      )}

      {adding && (
        <div className={`${card} p-4 space-y-3 border-[var(--leaf)]`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">New Memory Item</span>
            <button onClick={() => setAdding(false)} className="text-slate-500 hover:text-slate-300">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Category</label>
              <select
                value={cat}
                onChange={(e) => setCat(e.target.value as any)}
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
              >
                <option value="lessons_learned">Lessons Learned</option>
                <option value="environment_facts">Environment Facts</option>
                <option value="prompt_guidance">Prompt Guidance</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as any)}
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
              >
                <option value="project">Project Scope</option>
                <option value="global">Global User Scope</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short title, e.g. ESM require syntax error"
              className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
            />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Memory Content / Rule Text</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="Detailed explanation, rule, or fact..."
              className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="text-xs px-3 py-1.5 text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button
              onClick={() => createMut.mutate()}
              disabled={!title.trim() || !text.trim() || createMut.isPending}
              className="text-xs px-3 py-1.5 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded-md disabled:opacity-40"
            >
              Save Memory
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-slate-500 text-xs">Loading Memory Bank...</div>
      ) : activeList.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-xs bg-[var(--bark-900)]/40 rounded-xl border border-[var(--bark-600)]">
          No memory items found in this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {activeList.map((m) => {
            const meta = CATEGORY_META[m.category] ?? CATEGORY_META.lessons_learned;
            const Icon = meta.icon;
            const isEditing = editingId === m.id;
            const isPending = m.status === 'pending_review';
            const isRetired = Boolean(m.invalidAt);

            if (isEditing) {
              return (
                <div key={m.id} className={`${card} p-4 space-y-3 border-[var(--leaf)]`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200">Edit Memory</span>
                    <button onClick={() => setEditingId(null)} className="text-slate-500 hover:text-slate-300">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Category</label>
                      <select
                        value={cat}
                        onChange={(e) => setCat(e.target.value as any)}
                        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
                      >
                        <option value="lessons_learned">Lessons Learned</option>
                        <option value="environment_facts">Environment Facts</option>
                        <option value="prompt_guidance">Prompt Guidance</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Scope</label>
                      <select
                        value={scope}
                        onChange={(e) => setScope(e.target.value as any)}
                        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
                      >
                        <option value="project">Project Scope</option>
                        <option value="global">Global Scope</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Title</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Memory Content</label>
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={3}
                      className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingId(null)} className="text-xs px-3 py-1.5 text-slate-400 hover:text-slate-200">
                      Cancel
                    </button>
                    <button
                      onClick={() => updateMut.mutate({ id: m.id, title, text, category: cat, scope })}
                      disabled={!title.trim() || !text.trim() || updateMut.isPending}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded-md disabled:opacity-40"
                    >
                      <Save size={12} />
                      Save
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={m.id}
                className={`${card} p-4 flex flex-col justify-between ${
                  isRetired ? 'opacity-60 border-[var(--bark-600)]' : isPending ? 'border-amber-800/80 bg-amber-950/20' : ''
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border flex items-center gap-1 ${meta.color}`}>
                        <Icon size={11} />
                        {meta.label}
                      </span>
                      {m.scope === 'global' ? (
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border bg-purple-950/60 text-purple-300 border-purple-800 flex items-center gap-1">
                          <Globe size={10} />
                          Global Scope
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border bg-slate-800 text-slate-300 border-slate-700 flex items-center gap-1">
                          <Folder size={10} />
                          Project Scope
                        </span>
                      )}
                      {m.recommendedScope && m.recommendedScope !== m.scope && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                          Recommended: {m.recommendedScope}
                        </span>
                      )}
                      {isPending && !isRetired && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-900 text-amber-200 border border-amber-700">
                          Never Reached A Prompt
                        </span>
                      )}
                      {isRetired && (
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-[var(--bark-800)] text-slate-400 border border-[var(--bark-600)]">
                          Retired {new Date(m.invalidAt!).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isPending && (
                        <button
                          onClick={() => approveMut.mutate(m.id)}
                          title="Approve memory"
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-800/80 hover:bg-emerald-700 text-emerald-100 font-medium"
                        >
                          <Check size={12} />
                          Approve
                        </button>
                      )}
                      {m.scope !== 'global' && !isRetired && (
                        <button
                          onClick={() => promoteMut.mutate(m.id)}
                          title="Promote to global user scope"
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-800"
                        >
                          <ArrowUpRight size={12} />
                          Promote Global
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(m)}
                        title="Edit memory"
                        className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-700)]"
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        onClick={() => deleteMut.mutate(m.id)}
                        title="Delete memory"
                        className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-[var(--bark-700)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <h4 className="text-xs font-semibold text-slate-200 mb-1">{m.title}</h4>
                  <p className="text-[12px] text-slate-300 leading-relaxed font-mono bg-[var(--bark-900)]/60 p-2 rounded border border-[var(--bark-600)]">
                    {m.text}
                  </p>

                  <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500">
                    <span>
                      Read {m.useCount ? `${m.useCount}×` : 'never'}
                      {m.lastUsedAt && <> · last {new Date(m.lastUsedAt).toLocaleDateString()}</>}
                    </span>
                    {m.supersededBy && (
                      <span className="truncate">
                        Superseded by <span className="text-slate-400">{titleOf(m.supersededBy) ?? m.supersededBy}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
