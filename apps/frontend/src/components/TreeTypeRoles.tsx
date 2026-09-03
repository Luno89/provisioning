import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { card } from '../lib/pack-editor.js';
import { api } from '../api/client';
import { listPacks, type PersonaPack } from '../api/packs';
import { updateTreeType, groveKeys } from '../api/grove';
import PersonaConfigDrawer from './PersonaConfigDrawer';

interface TreeTypeRecord {
  id: string;
  label: string;
  summary: string;
  packs?: { planner?: string; judge?: string; merger?: string };
  [key: string]: unknown;
}

const ROLES = [
  { key: 'planner', label: 'Planner', hint: 'Turns the project goal into leaves.' },
  { key: 'judge', label: 'Judge', hint: "Reviews each leaf's finished work." },
  { key: 'merger', label: 'Merger', hint: 'Resolves conflicts when a leaf lands.' },
] as const;

export function TreeTypeRoles() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ typeId: string; role: typeof ROLES[number]['key'] } | null>(null);

  const { data: types = [] } = useQuery<TreeTypeRecord[]>({
    queryKey: groveKeys.treeTypes(),
    queryFn: () => api.get<TreeTypeRecord[]>('/tree-types').then((r) => r.data),
  });

  const { data: packs = [] } = useQuery<PersonaPack[]>({
    queryKey: ['packs'],
    queryFn: listPacks,
  });

  const packName = (slug: string | undefined) => {
    if (!slug) return 'None set — falls back to harness defaults';
    return packs.find((p) => p.slug === slug)?.name ?? slug;
  };

  const assign = useMutation({
    mutationFn: async ({ type, role, packId }: { type: TreeTypeRecord; role: string; packId: string }) => {
      const slug = packs.find((p) => p.id === packId)?.slug ?? packId;
      await updateTreeType(type.id, { ...type, packs: { ...type.packs, [role]: slug } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groveKeys.treeTypes() }),
  });

  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
        Project Types ({types.length})
      </h3>
      <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
        Which pack runs each role for a project of this type — same picker as Koala's, so a role's
        model and tools are configured in exactly one place regardless of where it runs.
      </p>

      <div className="space-y-2">
        {types.map((t) => (
          <div key={t.id} className={card}>
            <button
              onClick={() => setOpen(open === t.id ? null : t.id)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left"
            >
              {open === t.id ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
              <span className="font-semibold text-slate-200">{t.label}</span>
              <span className="text-[12px] text-slate-500 truncate">{t.summary}</span>
            </button>

            {open === t.id && (
              <div className="px-4 pb-4 border-t border-[var(--bark-600)] pt-3 space-y-2">
                {ROLES.map((role) => (
                  <div key={role.key} className="flex items-center justify-between gap-3 text-[12px]">
                    <div className="min-w-0">
                      <span className="font-semibold text-slate-300">{role.label}</span>
                      <span className="text-slate-500"> — {role.hint}</span>
                      <div className="flex items-center gap-1.5 mt-0.5 text-slate-400">
                        <Sparkles size={11} className="text-slate-600" />
                        <span className="truncate">{packName(t.packs?.[role.key])}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => setEditing({ typeId: t.id, role: role.key })}
                      className="shrink-0 text-[11px] text-[var(--leaf-light)] hover:text-white"
                    >
                      Change
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <PersonaConfigDrawer
          isOpen
          onClose={() => setEditing(null)}
          activePackId={types.find((t) => t.id === editing.typeId)?.packs?.[editing.role] ?? ''}
          onSelectPack={(packId) => {
            const type = types.find((t) => t.id === editing.typeId);
            if (type) assign.mutate({ type, role: editing.role, packId });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

export default TreeTypeRoles;
