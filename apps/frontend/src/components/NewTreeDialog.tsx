import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, X } from 'lucide-react';
import { listTreeTypes, createTree, groveKeys } from '../api/grove';
import { Becomes } from './TreeTypes/Becomes';
import type { TreeType } from '../types/grove.js';

export default function NewTreeDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated?: (treeId: string) => void;
}) {
  const qc = useQueryClient();
  const [pickedType, setPickedType] = useState('');
  const [pickedVersion, setPickedVersion] = useState<string | undefined>(undefined);

  const { data: types = [] } = useQuery<TreeType[]>({
    queryKey: groveKeys.treeTypes(),
    queryFn: listTreeTypes,
    staleTime: Infinity,
  });

  const create = useMutation({
    mutationFn: (body: { name: string; type: string; goal: string; version?: string }) => createTree<{ id: string }>(body),
    onSuccess: (tree: { id: string }) => {
      qc.invalidateQueries({ queryKey: ['trees'] });
      onCreated?.(tree?.id ?? '');
      onClose();
    },
  });

  const chosen = types.find((t) => t.id === pickedType);
  const version = chosen?.versions ? pickedVersion ?? chosen.versions.default : undefined;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-50" onClick={onClose}>
      <div
        className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-3xl p-8 w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-2xl font-bold">New tree</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={20} /></button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            create.mutate({
              name: String(data.get('name') ?? ''),
              type: pickedType,
              goal: String(data.get('goal') ?? ''),
              ...(version ? { version } : {}),
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
                  key={t.id} type="button" onClick={() => { setPickedType(t.id); setPickedVersion(undefined); }}
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
            {chosen?.versions && (
              <div className="mt-3" role="radiogroup" aria-label={`${chosen.versions.of} version`}>
                <div className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2">{chosen.versions.of} version</div>
                <div className="flex gap-2">
                  {chosen.versions.choices.map((choice) => (
                    <button
                      key={choice.version} type="button" role="radio" aria-checked={version === choice.version}
                      onClick={() => setPickedVersion(choice.version)}
                      className={`px-3 py-1.5 rounded-lg border text-[12px] ${version === choice.version ? 'border-[var(--leaf)] bg-[var(--leaf-stem)]/20 text-slate-100' : 'border-[var(--bark-600)] text-slate-400 hover:bg-[var(--bark-700)]'}`}
                    >
                      {chosen.versions!.of} {choice.version}{choice.version === chosen.versions!.default ? ' (default)' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chosen && (
              <>
              <p className="mt-3 text-[11px] text-slate-400 leading-relaxed border-l-2 border-[var(--leaf)] pl-3">
                <strong className="text-slate-300">Done means:</strong> {chosen.doneMeans}
                {chosen.produces === 'service'
                  ? ' It gets a project of its own: a repository whose every push builds and deploys to your cluster.'
                  : ' It produces an answer, so it gets no project: nothing is built or deployed.'}
              </p>
              <details className="mt-2 text-[11px] text-slate-400">
                <summary className="cursor-pointer text-slate-300">What a tree of this type becomes</summary>
                <div className="mt-2 max-h-64 overflow-y-auto"><Becomes typeId={chosen.id} /></div>
              </details>
              </>
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
            <button type="button" onClick={onClose} className="px-5 py-2.5 rounded-xl text-slate-400 hover:text-white">
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
  );
}
