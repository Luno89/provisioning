import type { WorkspaceLanguage } from './workspace-spec.js';

export type TreeType = string;

export interface Tree {
  id: string;
  ownerId: string;
  name: string;
  type: TreeType;
  goal?: string;
  /**
   * What Koala learned in the conversation that proposed this. The goal is one or two sentences;
   * these carry the rest, so the planner does not start from a paraphrase of a paraphrase.
   */
  brief?: string;
  context?: string;
  openQuestions?: string;
  /** The conversation this came from, so the Grove can link back to it. */
  conversationId?: string;
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
export const MAX_BRIEF = 6000;
export const MAX_CONTEXT = 6000;
export const MAX_OPEN_QUESTIONS = 2000;

export interface TreeInput {
  name: string;
  type: TreeType;
  goal?: string;
  brief?: string;
  context?: string;
  openQuestions?: string;
}

const text = (raw: Record<string, unknown>, key: string, cap: number): string =>
  (typeof raw[key] === 'string' ? (raw[key] as string).trim().slice(0, cap) : '');

export function normaliseTreeInput(raw: Record<string, unknown>): TreeInput | undefined {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return undefined;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!type) return undefined;

  const goal = text(raw, 'goal', MAX_GOAL);
  const brief = text(raw, 'brief', MAX_BRIEF);
  const context = text(raw, 'context', MAX_CONTEXT);
  const openQuestions = text(raw, 'openQuestions', MAX_OPEN_QUESTIONS);
  return {
    name,
    type,
    ...(goal ? { goal } : {}),
    ...(brief ? { brief } : {}),
    ...(context ? { context } : {}),
    ...(openQuestions ? { openQuestions } : {}),
  };
}

export function withProject(tree: Tree, projectId: string, now = new Date().toISOString()): Tree {
  if (tree.projectIds?.includes(projectId)) return tree;
  return { ...tree, projectIds: [...(tree.projectIds ?? []), projectId], updatedAt: now };
}
