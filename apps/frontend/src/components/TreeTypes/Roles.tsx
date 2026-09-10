import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { listPacks, type PersonaPack } from '../../api/packs.js';
import PersonaConfigDrawer from '../PersonaConfigDrawer.js';
import { TREE_TYPE_PACK_ROLES, type TreeType, type TreeTypePackRole } from './shared.js';

const ROLE_HINTS: Record<TreeTypePackRole, string> = {
  planner: 'Turns the project goal into leaves, and answers chat on a branch of this type.',
  judge: "Reviews each leaf's finished work.",
  merger: 'Resolves conflicts when a leaf lands.',
};

export function Roles({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const [editingRole, setEditingRole] = useState<TreeTypePackRole | null>(null);

  const { data: packs = [] } = useQuery<PersonaPack[]>({ queryKey: ['packs'], queryFn: listPacks });

  const packName = (slug: string | undefined) => {
    if (!slug) return 'None set — falls back to harness defaults';
    return packs.find((p) => p.slug === slug)?.name ?? slug;
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        Which pack fills each role for a project of this type — same picker as Koala's, so a role's
        model and tools are configured in exactly one place regardless of where it runs.
      </p>

      {TREE_TYPE_PACK_ROLES.map((role) => (
        <div key={role} className="flex items-center justify-between gap-3 text-[12px] bg-[var(--bark-900)]/60 border border-[var(--bark-600)] rounded-lg px-3 py-2.5">
          <div className="min-w-0">
            <span className="font-semibold text-slate-300 capitalize">{role}</span>
            <span className="text-slate-500"> — {ROLE_HINTS[role]}</span>
            <div className="flex items-center gap-1.5 mt-0.5 text-slate-400">
              <Sparkles size={11} className="text-slate-600" />
              <span className="truncate">{packName(value.packs?.[role])}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditingRole(role)}
            className="shrink-0 text-[11px] text-[var(--leaf-light)] hover:text-white cursor-pointer"
          >
            Change
          </button>
        </div>
      ))}

      {editingRole && (
        <PersonaConfigDrawer
          isOpen
          onClose={() => setEditingRole(null)}
          activePackId={value.packs?.[editingRole] ?? ''}
          onSelectPack={(packId) => {
            const slug = packs.find((p) => p.id === packId)?.slug ?? packId;
            onChange({ packs: { ...value.packs, [editingRole]: slug } });
            setEditingRole(null);
          }}
        />
      )}
    </div>
  );
}

export default Roles;
