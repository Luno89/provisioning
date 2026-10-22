import { sanitiseRepoName } from './projects.js';
import type { Tree } from './trees.js';
import type { TreeTypeSpec } from './tree-types.js';

export const projectIdForTree = (treeId: string): string => `project-${treeId}`;

export function needsProject(type: Pick<TreeTypeSpec, 'produces'> | undefined, tree: Pick<Tree, 'projectIds'>): boolean {
  return type?.produces === 'service' && !tree.projectIds?.length;
}

export function repoNameFor(name: string, taken: ReadonlySet<string>): string {
  const base = sanitiseRepoName(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
