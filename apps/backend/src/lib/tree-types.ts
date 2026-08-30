import { WORKSPACE_IMAGES, type WorkspaceLanguage } from './workspace-spec.js';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';

export interface TreeTypeFile {
  path: string;
  content: string;
  executable?: boolean | undefined;
}

export interface ValidationCheckDefinition {
  id: string;
  name: string;
  description?: string | undefined;
  type: 'file-exists' | 'content-matches' | 'run-command' | 'http-probe' | 'mcp-probe';
  target?: string | undefined;
  command?: string | undefined;
  pattern?: string | undefined;
  expectedStatus?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ValidationRecipe {
  type: 'document' | 'command' | 'runtime-service';
  checks: ValidationCheckDefinition[];
  timeoutMs?: number | undefined;
}

export interface TreeTypeSpec {
  id: string;
  ownerId: string;
  label: string;
  summary: string;
  language: WorkspaceLanguage;
  produces: 'service' | 'artefact';
  doneMeans: string;
  files: TreeTypeFile[];
  validationRecipe?: ValidationRecipe | undefined;
  defaultBindings?: string[] | undefined;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_STARTER_FILES = 20;

export function validateTreeType(candidate: Partial<TreeTypeSpec>): string | null {
  if (!candidate.id || !SLUG.test(candidate.id)) {
    return 'id must be a slug: lowercase letters, numbers and single hyphens.';
  }
  if (!candidate.label?.trim()) return 'label is required.';
  if (!candidate.summary?.trim()) return 'summary is required.';
  if (!candidate.doneMeans?.trim()) return 'doneMeans is required — it is what acceptance starts from.';

  if (!candidate.language || !(candidate.language in WORKSPACE_IMAGES)) {
    return `language must be one of ${Object.keys(WORKSPACE_IMAGES).join(', ')}.`;
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

  if (candidate.validationRecipe) {
    const r = candidate.validationRecipe;
    if (!['document', 'command', 'runtime-service'].includes(r.type)) {
      return 'validationRecipe.type must be "document", "command", or "runtime-service".';
    }
    if (!Array.isArray(r.checks)) {
      return 'validationRecipe.checks must be an array.';
    }
    for (const c of r.checks) {
      if (!c.id || typeof c.id !== 'string') return 'Each check must have a string id.';
      if (!c.name || typeof c.name !== 'string') return 'Each check must have a string name.';
      if (!['file-exists', 'content-matches', 'run-command', 'http-probe', 'mcp-probe'].includes(c.type)) {
        return `Unknown check type "${c.type}" in validationRecipe.`;
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
  // The user's own row wins over the shipped one; the shipped one is a real database row, not the
  // seed constant. Matching `ownerId === ownerId` alone could never find a built-in once seeded
  // rows became ownerless, so every untouched type silently resolved to the constant and an edit
  // to the shipped record reached nobody.
  const mine = all.find((t) => t.id === id && t.ownerId === ownerId);
  const shipped = all.find((t) => t.id === id && t.ownerId === undefined);
  const found = mine ?? shipped;
  if (!found) return undefined;

  // Backfill only what a legacy row is missing, from the seed it was written from.
  const seed = TREE_TYPE_SEEDS_VALUE.find((s) => s.id === id);
  if (seed && (!found.validationRecipe || !found.files?.length)) {
    return {
      ...found,
      validationRecipe: found.validationRecipe ?? seed.validationRecipe,
      files: found.files?.length ? found.files : seed.files,
    };
  }
  return found;
}

export type TreeTypeSeed = Omit<TreeTypeSpec, 'ownerId'>;

export { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

export interface TreeTypeSeedStore extends TreeTypeStore {
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
}

export async function seedTreeTypes(store: TreeTypeSeedStore): Promise<number> {
  const stored = await store.getTreeTypes().catch(() => [] as TreeTypeSpec[]);
  const have = new Map(stored.filter((t) => t.ownerId === undefined).map((t) => [t.id, t]));

  let updated = 0;
  for (const seed of TREE_TYPE_SEEDS_VALUE) {
    const existing = have.get(seed.id);
    if (!existing) {
      await store.saveTreeType({ ...seed } as TreeTypeSpec);
      updated++;
    } else if (!existing.validationRecipe && seed.validationRecipe) {
      await store.saveTreeType({
        ...existing,
        validationRecipe: seed.validationRecipe,
        files: existing.files?.length ? existing.files : seed.files,
      });
      updated++;
    }
  }
  return updated;
}
