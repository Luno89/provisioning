import type { Branch, Leaf } from './leaves.js';
import type { Task } from './tasks.js';
import type { Tree } from './trees.js';

export type OutlineTree = Pick<Tree, 'id' | 'name' | 'type' | 'goal'>;
export type OutlineBranch = Pick<Branch, 'id' | 'treeId' | 'title'>;
export type OutlineLeaf = Pick<Leaf, 'id' | 'branchId' | 'title' | 'body' | 'status' | 'dependsOn' | 'runner'>;
export type OutlineTask = Pick<Task, 'leafId' | 'status'>;

export const MAX_OUTLINE_LEAVES = 60;

export function treeOutline(
  tree: OutlineTree,
  branches: readonly OutlineBranch[],
  leaves: readonly OutlineLeaf[],
  tasks: readonly OutlineTask[] = [],
): string {
  const own = branches.filter((branch) => branch.treeId === tree.id);
  const header = [
    `Tree "${tree.name}" (${tree.id}), type ${tree.type}.`,
    tree.goal ? `Goal: ${tree.goal}` : 'Goal: not written down.',
  ];

  let shown = 0;
  const sections = own.map((branch) => {
    const under = leaves.filter((leaf) => leaf.branchId === branch.id && leaf.status !== 'cancelled');
    const lines = under.slice(0, Math.max(0, MAX_OUTLINE_LEAVES - shown)).map((leaf) => {
      const live = tasks.filter((task) => task.leafId === leaf.id && task.status !== 'proposed' && task.status !== 'dropped');
      const done = live.filter((task) => task.status === 'done').length;
      const waits = leaf.dependsOn?.length ? `, waits on ${leaf.dependsOn.join(', ')}` : '';
      const legacy = leaf.runner === 'engine' ? '' : ', legacy';
      return `  - ${leaf.title} (${leaf.id}) [${leaf.status}${legacy}, ${done}/${live.length} tasks done${waits}]${leaf.body ? ` — ${leaf.body}` : ''}`;
    });
    shown += lines.length;
    const hidden = under.length - lines.length;
    return [`- ${branch.title}`, ...lines, ...(hidden > 0 ? [`  - …and ${hidden} more`] : [])].join('\n');
  });

  return [
    ...header,
    '',
    sections.length > 0 ? `Branches and their leaves:\n${sections.join('\n')}` : 'Nothing is planned in it yet.',
  ].join('\n');
}
