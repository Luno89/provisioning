import { useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bot, FolderTree, GitBranch, Network } from 'lucide-react';
import { listTreeTypes, groveKeys } from '../../api/grove.js';
import { errorMessage } from '../../api/client.js';
import Explorer, { FileHeader, type ExplorerGroup } from '../Studio/Explorer';
import { groupTreeTypes } from '../../lib/studio-groups';
import { TreeTypeEditor, type TreeTypeSection } from './TreeTypeEditor.js';
import type { TreeType } from './shared.js';

const FILES: readonly { id: Exclude<TreeTypeSection, 'overview'>; title: string; icon: typeof Bot; says: string }[] = [
  { id: 'grown-by', title: 'Grown by', icon: Bot, says: 'The agent whose procedure grows a tree of this type, start to finish.' },
  { id: 'scaffold', title: 'Scaffold', icon: FolderTree, says: 'Starter files rendered into a fresh repository when a tree of this type is created.' },
  { id: 'bindings', title: 'Bindings', icon: Network, says: 'Default service bindings, extra network egress, and fixed environment variables.' },
];

const isSection = (value: string | undefined): value is TreeTypeSection => value === 'overview' || FILES.some((file) => file.id === value);

export function TreeTypes() {
  const { typeId, part } = useParams({ strict: false }) as { typeId?: string; part?: string };
  const navigate = useNavigate();
  const [creating, setCreating] = useState<string>();
  const { data: types = [], isLoading, isError, error } = useQuery<TreeType[]>({ queryKey: groveKeys.treeTypes(), queryFn: listTreeTypes });

  const type = types.find((one) => one.id === typeId);
  const section: TreeTypeSection | undefined = part === undefined ? (typeId ? 'overview' : undefined) : isSection(part) ? part : undefined;

  const groups: ExplorerGroup[] = groupTreeTypes(types).map((group) => ({
    id: group.id,
    title: group.title,
    items: group.items.map((one) => ({
      id: one.id,
      label: one.label,
      mine: Boolean(one.ownerId),
      icon: GitBranch,
      link: { to: '/studio/tree-types/$typeId', params: { typeId: one.id } },
      files: FILES.map((file) => ({ id: file.id, title: file.title, icon: file.icon, link: { to: '/studio/tree-types/$typeId/$part', params: { typeId: one.id, part: file.id } } })),
    })),
  }));

  const path = [
    { label: 'Tree Types', link: { to: '/studio/tree-types' } },
    ...(creating !== undefined ? [{ label: 'New tree type' }] : []),
    ...(creating === undefined && type ? [{ label: type.label, link: { to: '/studio/tree-types/$typeId', params: { typeId: type.id } } }] : []),
    ...(creating === undefined && type && section && section !== 'overview' ? [{ label: FILES.find((file) => file.id === section)?.title ?? section }] : []),
  ];
  const file = FILES.find((one) => one.id === section);

  return (
    <Explorer
      title="Tree Types"
      groups={groups}
      selected={typeId ? { item: typeId, file: section === 'overview' ? undefined : section } : undefined}
      path={path}
      onNew={(label) => setCreating(label)}
      newPlaceholder="New tree type's name, then Enter"
      loading={isLoading}
      error={isError ? errorMessage(error) : undefined}
    >
      {creating !== undefined ? (
        <TreeTypeEditor
          key={`new-${creating}`}
          type={undefined}
          initialLabel={creating}
          types={types}
          onSaved={(saved) => { setCreating(undefined); void navigate({ to: '/studio/tree-types/$typeId', params: { typeId: saved.id } }); }}
        />
      ) : !typeId ? (
        <div className="max-w-xl space-y-2 pt-10 text-sm text-slate-400">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><GitBranch size={20} className="text-[var(--leaf)]" /> Tree Types</h1>
          <p>What a project of a given type starts from: its language, what done means, starter files and the services it binds to. The ones on the left are grouped by what they make — something that runs, or a document or artefact.</p>
        </div>
      ) : isLoading ? null : !type ? (
        <p className="text-sm text-slate-400">There is no tree type called “{typeId}”.</p>
      ) : !section ? (
        <p className="text-sm text-slate-400">{type.label} has no part called “{part}”.</p>
      ) : (
        <div>
          {file && <FileHeader title={file.title} says={file.says} />}
          <TreeTypeEditor key={`${type.id}-${section}`} type={type} types={types} only={section} />
        </div>
      )}
    </Explorer>
  );
}

export default TreeTypes;
