import type { WorkspaceLanguage } from './workspace-spec.js';

export type TreeType = string;

export interface Tree {
  id: string;
  ownerId: string;
  name: string;
  type: TreeType;
  goal?: string;
  projectIds?: string[];
  serviceName?: string;
  createdAt: string;
  updatedAt: string;
}

export function primaryProjectId(tree: Pick<Tree, 'projectIds'>): string | undefined {
  return tree.projectIds?.[0];
}

const MAX_NAME = 120;
const MAX_GOAL = 2000;

export function normaliseTreeInput(raw: Record<string, unknown>): { name: string; type: TreeType; goal?: string } | undefined {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return undefined;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!type) return undefined;
  const goal = typeof raw.goal === 'string' ? raw.goal.trim().slice(0, MAX_GOAL) : '';
  return { name, type, ...(goal ? { goal } : {}) };
}

export function withProject(tree: Tree, projectId: string, now = new Date().toISOString()): Tree {
  if (tree.projectIds?.includes(projectId)) return tree;
  return { ...tree, projectIds: [...(tree.projectIds ?? []), projectId], updatedAt: now };
}
