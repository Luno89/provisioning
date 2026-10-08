import type { WorkspaceLanguage } from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { PersonaEgressRule } from '@koala/harness-types';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';
import { sameSeededRow } from './seed-diff.js';
import { validateEgressRules } from './egress-rules.js';

export const DEFAULT_GROVE_AGENT = 'grove';

export const groveAgentOf = (type: { agent?: string | undefined } | undefined): string => type?.agent || DEFAULT_GROVE_AGENT;

export interface TreeTypeFile {
  path: string;
  content: string;
  executable?: boolean | undefined;
}

export interface TreeTypeSpec {
  id: string;
  ownerId: string;
  label: string;
  summary: string;
  language: WorkspaceLanguage;
  produces: 'service' | 'artefact';
  doneMeans: string;
  requireSources?: boolean | undefined;
  files: TreeTypeFile[];
  defaultBindings?: string[] | undefined;
  egress?: PersonaEgressRule[] | undefined;
  env?: { name: string; value: string }[] | undefined;
  agent?: string | undefined;
}

export function agentProblem(agent: unknown, agents: readonly string[]): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== 'string' || !agent.trim()) return 'agent must name the agent that grows trees of this type.';
  if (!agents.includes(agent)) return `the type names "${agent}" to grow its trees, which is not one of your agents.`;
  return null;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_STARTER_FILES = 20;

export function validateTreeType(
  images: readonly WorkspaceImageSpec[],
  candidate: Partial<TreeTypeSpec>,
): string | null {
  if (!candidate.id || !SLUG.test(candidate.id)) {
    return 'id must be a slug: lowercase letters, numbers and single hyphens.';
  }
  if (!candidate.label?.trim()) return 'label is required.';
  if (!candidate.summary?.trim()) return 'summary is required.';
  if (!candidate.doneMeans?.trim()) return 'doneMeans is required — it is what acceptance starts from.';

  if (!candidate.language || !images.some((i) => i.id === candidate.language)) {
    return `language must be one of ${images.map((i) => i.id).join(', ')}.`;
  }
  if (candidate.produces !== 'service' && candidate.produces !== 'artefact') {
    return 'produces must be "service" or "artefact".';
  }

  const files = candidate.files ?? [];
  if (files.length > MAX_STARTER_FILES) return `A type may start from at most ${MAX_STARTER_FILES} files.`;
  for (const file of files) {
    if (!file?.path || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      return `Starter file path ${JSON.stringify(file?.path ?? '')} must be relative and stay inside the repository.`;
    }
  }

  const badEgress = validateEgressRules(candidate.egress);
  if (badEgress) return badEgress;

  if (candidate.env !== undefined) {
    if (!Array.isArray(candidate.env)) return 'env must be a list of {name, value} pairs.';
    for (const e of candidate.env) {
      if (!e || typeof e.name !== 'string' || !e.name.trim() || typeof e.value !== 'string') {
        return 'Each env entry needs a string name and a string value.';
      }
    }
  }

  return null;
}

export interface StarterVars {
  projectName: string;
  registryHost: string;
}

export function renderStarterFiles(files: readonly TreeTypeFile[], vars: StarterVars): TreeTypeFile[] {
  const fill = (text: string) => text.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => (key in vars ? String(vars[key as keyof StarterVars]) : whole),
  );
  return files.map((f) => ({
    path: fill(f.path),
    content: fill(f.content),
    // A starter script is no use to anybody if it arrives unrunnable.
    ...(f.executable ? { executable: true } : {}),
  }));
}

export interface TreeTypeStore {
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
}

/**
 * The types a person can choose from: their own row shadows the shipped one at the same id.
 *
 * `getTreeTypes(ownerId)` is an owner-scoped filter, not a merge, so it hands back both rows for a
 * type somebody has edited — and a caller that takes the first match reads the shipped defaults
 * instead of what the person chose.
 */
export function treeTypesFor<T extends { id: string; ownerId?: string | undefined }>(
  rows: readonly T[],
  ownerId: string,
): T[] {
  // Somebody else's row is not a choice this person has, whatever the caller handed over — and an
  // unfiltered list would let their edit shadow the shipped type for everyone.
  const visible = rows.filter((row) => row.ownerId === undefined || row.ownerId === ownerId);
  const mine = new Set(visible.filter((row) => row.ownerId === ownerId).map((row) => row.id));
  return visible.filter((row) => row.ownerId === ownerId || !mine.has(row.id));
}

export async function resolveTreeType<T extends { id: string; ownerId?: string | undefined }>(
  store: { getTreeTypes(ownerId?: string): Promise<T[]> },
  ownerId: string,
  id: string | undefined,
): Promise<T | undefined> {
  if (!id) return undefined;
  const all = await store.getTreeTypes(ownerId).catch(() => [] as T[]);
  return all.find((t) => t.id === id && t.ownerId === ownerId) ?? all.find((t) => t.id === id && t.ownerId === undefined);
}

export function treeLanguageFrom(store: {
  getTrees(): Promise<{ id: string; ownerId?: string | undefined; type?: string | undefined }[]>;
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
}): (ownerId: string, treeId: string) => Promise<string | undefined> {
  return async (ownerId, treeId) => {
    const tree = (await store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    return (await resolveTreeType(store, ownerId, tree?.type))?.language;
  };
}

export type TreeTypeSeed = Omit<TreeTypeSpec, 'ownerId'>;

/**
 * The narrow view of the types a person can choose from — what the planner's `list_tree_types` shows
 * and what a grove run reads its agent from. One rule, so the two cannot disagree about which row
 * wins.
 */
export function treeTypeChoices(
  rows: readonly TreeTypeSpec[],
  ownerId: string,
): { id: string; label: string; summary: string; agent?: string | undefined }[] {
  return treeTypesFor(rows, ownerId).map((type) => ({
    id: type.id,
    label: type.label,
    summary: type.summary,
    ...(type.agent ? { agent: type.agent } : {}),
  }));
}

export { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

export interface TreeTypeSeedStore extends TreeTypeStore {
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
}

export async function seedTreeTypes(store: TreeTypeSeedStore): Promise<number> {
  const stored = await store.getTreeTypes().catch(() => [] as TreeTypeSpec[]);
  const shipped = new Map(stored.filter((t) => t.ownerId === undefined).map((t) => [t.id, t]));

  let seeded = 0;
  for (const seed of TREE_TYPE_SEEDS_VALUE) {
    const existing = shipped.get(seed.id);
    // A shipped type keeps up with its seed: a type that gains a stage has to reach the installs that
    // already hold it, or they silently run the defaults. A person's own edit shadows the shipped row
    // by id and is never written over. Types the code stops shipping are left alone — a tree may
    // still be of that type, and deleting it would orphan the tree rather than help anybody.
    if (existing && sameSeededRow(existing, seed)) continue;
    await store.saveTreeType({ ...seed } as TreeTypeSpec);
    seeded++;
  }
  return seeded;
}
