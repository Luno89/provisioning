import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Plus, Loader2, Trash2, MessageSquare, Target, X, LayoutGrid } from 'lucide-react';
import TreeBoard from './TreeBoard.js';

/**
 * Trees — the projects that conversations belong to.
 *
 * ── WHY A LAYER ABOVE BRANCHES ──
 * A branch is one request. A tree is the thing the requests are FOR, and it owns what should
 * outlive any single conversation: the repository, what has been learned, and what done means.
 *
 * Without it everything hung off the branch, and a repository was created PER branch — measured on
 * this instance, 27 projects existed and 26 had never produced a build, because a second
 * conversation about the same work started somewhere else entirely.
 *
 * This step introduces the record and the filing. Moving repository and memory ownership onto the
 * tree is the next one, deliberately separate: a new concept and a migration landing together is
 * how you end up unable to tell which of the two broke something.
 */

interface TreeType {
  id: string;
  label: string;
  summary: string;
  usesRepo: boolean;
  doneMeans: string;
}

interface Tree {
  id: string;
  name: string;
  type: string;
  goal?: string;
  projectIds?: string[];
  branchCount: number;
  updatedAt: string;
}

export default function Trees({ apiBase, onReview }: {
  apiBase: string;
  /** Hands a failed leaf's evidence to Koala. The board never opens a conversation itself. */
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [pickedType, setPickedType] = useState('');
  /** Which tree's board is open. The list is the index; the board is the project. */
  const [openTree, setOpenTree] = useState<string | null>(null);

  // Names only — the board labels cards with who did the work, and an id tells nobody anything.
  const { data: personas = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['personas'],
    queryFn: () => axios.get(`${apiBase}/personas`, { withCredentials: true }).then((r) => r.data),
    staleTime: 60_000,
  });

  const { data: types = [] } = useQuery<TreeType[]>({
    queryKey: ['tree-types'],
    queryFn: () => axios.get(`${apiBase}/tree-types`, { withCredentials: true }).then((r) => r.data),
    // The catalogue only changes when the code does.
    staleTime: Infinity,
  });

  const { data: trees = [], isLoading } = useQuery<Tree[]>({
    queryKey: ['trees'],
    queryFn: () => axios.get(`${apiBase}/trees`, { withCredentials: true }).then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; type: string; goal: string }) =>
      axios.post(`${apiBase}/trees`, body, { withCredentials: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trees'] });
      setCreating(false);
      setPickedType('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/trees/${id}`, { withCredentials: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trees'] });
      // The conversations survive un-scoped, so the branch list is stale too.
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const typeOf = (id: string) => types.find((t) => t.id === id);
  const chosen = typeOf(pickedType);

  /**
   * The board replaces the list rather than sitting beside it.
   *
   * A project board wants the width — six columns of cards — and a list of other projects beside it
   * earns nothing while you are reading one.
   */
  if (openTree) {
    return (
      <TreeBoard
        apiBase={apiBase}
        treeId={openTree}
        personaNames={Object.fromEntries(personas.map((p) => [p.id, p.name]))}
        onBack={() => setOpenTree(null)}
        {...(onReview ? { onReview } : {})}
      />
    );
  }

  return (
    <section>
      <header className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-3xl font-bold">Trees</h2>
          <p className="text-slate-400">
            A tree is a project. Conversations are filed under it, and it owns what outlives any one of them.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all"
        >
          <Plus size={18} /> New Tree
        </button>
      </header>

      {isLoading ? (
        <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading trees…</div>
      ) : trees.length === 0 ? (
        <div className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-3xl p-12 text-center max-w-2xl">
          <h3 className="text-xl font-bold mb-2">No trees yet</h3>
          <p className="text-slate-400 text-sm">
            Start one for a thing you are actually making — an API, a paper, a dataset. Its type decides
            how the work gets checked.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {trees.map((tree) => {
            const spec = typeOf(tree.type);
            return (
              <div key={tree.id} className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-2xl p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 cursor-pointer" onClick={() => setOpenTree(tree.id)}>
                    <h4 className="font-bold text-lg truncate hover:text-[var(--leaf)]">{tree.name}</h4>
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf)]">
                      {spec?.label ?? tree.type}
                    </span>
                  </div>
                  <button
                    onClick={() => remove.mutate(tree.id)}
                    title="Delete this tree. Its conversations survive, un-filed."
                    className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)] shrink-0"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {tree.goal && <p className="text-[13px] text-slate-400 leading-relaxed">{tree.goal}</p>}

                {/* What done means, from the type. Shown on the tree because a definition of done
                    nobody reads is the same as not having one. */}
                {spec && (
                  <p className="text-[11px] text-slate-500 leading-relaxed flex gap-2">
                    <Target size={13} className="shrink-0 mt-0.5" /> {spec.doneMeans}
                  </p>
                )}

                <div className="flex items-center gap-4 text-[11px] text-slate-500 pt-2 border-t border-[var(--bark-700)]">
                  <span className="flex items-center gap-1.5">
                    <MessageSquare size={12} /> {tree.branchCount} {tree.branchCount === 1 ? 'conversation' : 'conversations'}
                  </span>
                  {spec && !spec.usesRepo && <span>no repository</span>}
                  <button
                    onClick={() => setOpenTree(tree.id)}
                    className="ml-auto flex items-center gap-1.5 text-[var(--leaf)] hover:underline"
                  >
                    <LayoutGrid size={12} /> board
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-50" onClick={() => setCreating(false)}>
          <div
            className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-3xl p-8 w-full max-w-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold">New tree</h3>
              <button onClick={() => setCreating(false)} className="text-slate-500 hover:text-white"><X size={20} /></button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                create.mutate({
                  name: String(data.get('name') ?? ''),
                  type: pickedType,
                  goal: String(data.get('goal') ?? ''),
                });
              }}
              className="flex flex-col gap-5"
            >
              <div>
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2 block">Name</label>
                <input
                  name="name" required autoFocus placeholder="Koala API"
                  className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl px-4 py-2.5 text-sm focus:border-[var(--leaf)] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2 block">
                  Type — decides how the work is checked
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {types.map((t) => (
                    <button
                      key={t.id} type="button" onClick={() => setPickedType(t.id)}
                      className={`text-left px-4 py-3 rounded-xl border transition-colors ${
                        pickedType === t.id
                          ? 'border-[var(--leaf)] bg-[var(--leaf-stem)]/20'
                          : 'border-[var(--bark-600)] hover:bg-[var(--bark-700)]'
                      }`}
                    >
                      <div className="font-bold text-[13px]">{t.label}</div>
                      <div className="text-[11px] text-slate-400 leading-snug">{t.summary}</div>
                    </button>
                  ))}
                </div>
                {/* Shown before creating, not after: the definition of done is the thing worth
                    disagreeing with, and it is useless once the choice is already made. */}
                {chosen && (
                  <p className="mt-3 text-[11px] text-slate-400 leading-relaxed border-l-2 border-[var(--leaf)] pl-3">
                    <strong className="text-slate-300">Done means:</strong> {chosen.doneMeans}
                    {!chosen.usesRepo && ' This type produces an answer rather than files, so it gets no repository.'}
                  </p>
                )}
              </div>

              <div>
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2 block">Goal (optional)</label>
                <textarea
                  name="goal" rows={3} placeholder="What this tree is for, in your words."
                  className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl px-4 py-2.5 text-sm focus:border-[var(--leaf)] focus:outline-none resize-none"
                />
              </div>

              {create.isError && (
                <p className="text-red-400 text-xs">Could not create the tree. Check the name and type.</p>
              )}

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setCreating(false)} className="px-5 py-2.5 rounded-xl text-slate-400 hover:text-white">
                  Cancel
                </button>
                <button
                  type="submit" disabled={!pickedType || create.isPending}
                  className="bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 text-white px-6 py-2.5 rounded-xl font-bold flex items-center gap-2"
                >
                  {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
