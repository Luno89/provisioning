import type { WorkspaceLanguage } from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { PersonaEgressRule } from '@koala/harness-types';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';
import { validateEgressRules } from './egress-rules.js';
import { TREE_STAGES, type TreeStages } from './grove-stages.js';

export { DEFAULT_STAGES, TREE_STAGES, stagesOf, type TreeStage, type TreeStages } from './grove-stages.js';

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
  stages?: TreeStages | undefined;
}

export function stagesProblem(stages: unknown, agents: readonly string[]): string | null {
  if (stages === undefined) return null;
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return 'stages must be an object naming an agent per stage.';
  for (const [stage, agent] of Object.entries(stages as Record<string, unknown>)) {
    if (!(TREE_STAGES as readonly string[]).includes(stage)) return `"${stage}" is not a stage — the stages are ${TREE_STAGES.join(', ')}.`;
    if (agent === undefined) continue;
    if (typeof agent !== 'string' || !agent.trim()) return `the ${stage} stage must name an agent.`;
    if (!agents.includes(agent)) return `the ${stage} stage names "${agent}", which is not one of your agents.`;
  }
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
  return files.map((f) => ({ path: fill(f.path), content: fill(f.content) }));
}

export interface TreeTypeStore {
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
}

export async function resolveTreeType(
  store: TreeTypeStore,
  ownerId: string,
  id: string | undefined,
): Promise<TreeTypeSpec | undefined> {
  if (!id) return undefined;
  const all = await store.getTreeTypes(ownerId).catch(() => [] as TreeTypeSpec[]);
  return all.find((t) => t.id === id && t.ownerId === ownerId) ?? all.find((t) => t.id === id && t.ownerId === undefined);
}

export type TreeTypeSeed = Omit<TreeTypeSpec, 'ownerId'>;

export { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

export interface TreeTypeSeedStore extends TreeTypeStore {
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
}

export async function seedTreeTypes(store: TreeTypeSeedStore): Promise<number> {
  const stored = await store.getTreeTypes().catch(() => [] as TreeTypeSpec[]);
  const have = new Set(stored.filter((t) => t.ownerId === undefined).map((t) => t.id));

  let added = 0;
  for (const seed of TREE_TYPE_SEEDS_VALUE) {
    if (have.has(seed.id)) continue;
    await store.saveTreeType({ ...seed } as TreeTypeSpec);
    added++;
  }
  return added;
}
