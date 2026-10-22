import type { Branch, Leaf } from './leaves.js';
import { byRank } from './work-order.js';
import type { Task } from './tasks.js';
import type { Tree } from './trees.js';

export type ItemTree = Pick<Tree, 'id' | 'name'>;
export type ItemBranch = Pick<Branch, 'id' | 'treeId' | 'title'>;
export type ItemLeaf = Pick<Leaf, 'id' | 'branchId' | 'title' | 'body' | 'status' | 'dependsOn' | 'findings' | 'claim' | 'verified' | 'landed' | 'review' | 'attempts'> & Partial<Pick<Leaf, 'priority' | 'createdAt'>>;
export type ItemTask = Pick<Task, 'id' | 'leafId' | 'title' | 'status' | 'doneMeans' | 'evidence'>;

const MAX_TEXT = 1500;
const cut = (text: string, max = MAX_TEXT): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function storyOutline(leaf: ItemLeaf, place: { tree: ItemTree; branch: ItemBranch }, all: readonly ItemLeaf[], tasks: readonly ItemTask[]): string {
  const waits = (leaf.dependsOn ?? []).map((id) => all.find((other) => other.id === id)).filter((other): other is ItemLeaf => other !== undefined);
  const own = tasks.filter((task) => task.leafId === leaf.id && task.status !== 'dropped');
  const lines = [
    `Story "${leaf.title}" (${leaf.id}), in the feature "${place.branch.title}" (${place.branch.id}) of tree "${place.tree.name}" (${place.tree.id}).`,
    `State: ${leaf.status}${leaf.verified ? ', verified' : ''}${leaf.landed ? `, landed (${leaf.landed.outcome === 'merged' ? 'merged' : 'nothing to merge'})` : ''}.`,
    leaf.body ? `Brief: ${cut(leaf.body)}` : 'Brief: not written down.',
    ...(waits.length > 0 ? [`Waits on: ${waits.map((other) => `"${other.title}" (${other.status})`).join(', ')}.`] : []),
    ...(own.length > 0
      ? ['Tasks:', ...own.map((task) => `  - ${task.title} [${task.status}] — done means: ${cut(task.doneMeans, 300)}${task.evidence ? `; evidence: ${cut(task.evidence, 300)}` : ''}`)]
      : []),
    ...(leaf.claim ? [`Claimed done${leaf.claim.commit ? ` at commit ${leaf.claim.commit}` : ''}: ${cut(leaf.claim.evidence)}`] : []),
    ...(leaf.review ? [`The judge's verdict: ${leaf.review.verdict}${leaf.review.reason ? ` — ${cut(leaf.review.reason)}` : ''}.`] : []),
    ...(leaf.findings ? [`Findings: ${cut(leaf.findings)}`] : []),
    ...((leaf.attempts ?? []).length > 0
      ? [`Earlier attempts that failed:`, ...(leaf.attempts ?? []).map((attempt) => `  - attempt ${attempt.attempt}: ${cut(attempt.error, 400)}`)]
      : []),
  ];
  return lines.join('\n');
}

export function featureOutline(branch: ItemBranch, tree: ItemTree, leaves: readonly ItemLeaf[]): string {
  const own = leaves.filter((leaf) => leaf.branchId === branch.id && leaf.status !== 'cancelled').sort(byRank);
  return [
    `Feature "${branch.title}" (${branch.id}) of tree "${tree.name}" (${tree.id}).`,
    own.length > 0
      ? `Its stories:\n${own.map((leaf) => `  - ${leaf.title} (${leaf.id}) [${leaf.status}${leaf.verified ? ', verified' : ''}]${leaf.body ? ` — ${cut(leaf.body, 300)}` : ''}`).join('\n')}`
      : 'It has no stories yet.',
  ].join('\n');
}
