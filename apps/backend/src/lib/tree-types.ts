import type { WorkspaceLanguage } from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { PersonaEgressRule } from '@koala/harness-types';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';
import { validateEgressRules } from './personas.js';

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

/**
 * Which pack fills each role for this kind of project, by pack slug.
 *
 * The binding lives here rather than in code because it is the same kind of fact as
 * `validationRecipe` — what proves an mcp-server is not what proves a research paper, and what
 * plans one is not what plans the other. Selecting a pack by matching a persona NAME in code is
 * what this replaces: a display name is user-editable, so the lookup broke whenever it was renamed.
 */
export interface TreeTypePacks {
  planner?: string | undefined;
  judge?: string | undefined;
  merger?: string | undefined;
}

export const TREE_TYPE_PACK_ROLES = ['planner', 'judge', 'merger'] as const;

export type TreeTypePackRole = typeof TREE_TYPE_PACK_ROLES[number];

export interface TreeTypeSpec {
  id: string;
  ownerId: string;
  label: string;
  summary: string;
  language: WorkspaceLanguage;
  produces: 'service' | 'artefact';
  doneMeans: string;
  /** Whether this kind of project's output must carry sources — checked by assessFindings, not just prompted. */
  requireSources?: boolean | undefined;
  files: TreeTypeFile[];
  validationRecipe?: ValidationRecipe | undefined;
  defaultBindings?: string[] | undefined;
  /** Reachability every leaf of this project type gets, beyond what defaultBindings already implies. */
  egress?: PersonaEgressRule[] | undefined;
  env?: { name: string; value: string }[] | undefined;
  packs?: TreeTypePacks | undefined;
  /** How readily a proposed leaf on this project type auto-accepts. Replaces the old hardcoded DEFAULT_POLICY. */
  autoAccept?: {
    enabled?: boolean;
    requirePersona?: boolean;
    max?: number;
    minTitleChars?: number;
    minBodyChars?: number;
  } | undefined;
  /** 0-1 similarity above which two leaves get flagged as possible duplicates. Replaces SIMILAR_ENOUGH_TO_ASK. */
  duplicateThreshold?: number | undefined;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_STARTER_FILES = 20;

export function validateTreeType(
  images: readonly WorkspaceImageSpec[],
  candidate: Partial<TreeTypeSpec>,
  packSlugs?: readonly string[],
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

  if (candidate.packs) {
    if (typeof candidate.packs !== 'object' || Array.isArray(candidate.packs)) {
      return 'packs must be an object mapping a role to a pack slug.';
    }
    for (const [role, slug] of Object.entries(candidate.packs)) {
      if (slug === undefined) continue;
      if (!(TREE_TYPE_PACK_ROLES as readonly string[]).includes(role)) {
        return `Unknown pack role "${role}". Roles are ${TREE_TYPE_PACK_ROLES.join(', ')}.`;
      }
      if (typeof slug !== 'string' || !slug.trim()) return `packs.${role} must be a pack slug.`;
      // Only checked when the caller knows the catalogue; the seed test validates without one.
      if (packSlugs && !packSlugs.includes(slug)) {
        return `packs.${role} names no pack you can use: "${slug}".`;
      }
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

  if (candidate.autoAccept !== undefined) {
    const a = candidate.autoAccept;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return 'autoAccept must be an object.';
    if (a.enabled !== undefined && typeof a.enabled !== 'boolean') return 'autoAccept.enabled must be true or false.';
    if (a.requirePersona !== undefined && typeof a.requirePersona !== 'boolean') {
      return 'autoAccept.requirePersona must be true or false.';
    }
    for (const key of ['max', 'minTitleChars', 'minBodyChars'] as const) {
      const v = a[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
        return `autoAccept.${key} must be a non-negative integer.`;
      }
    }
  }

  if (candidate.duplicateThreshold !== undefined) {
    const t = candidate.duplicateThreshold;
    if (typeof t !== 'number' || t < 0 || t > 1) return 'duplicateThreshold must be a number between 0 and 1.';
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
  if (seed && (!found.validationRecipe || !found.files?.length || !found.packs)) {
    return {
      ...found,
      validationRecipe: found.validationRecipe ?? seed.validationRecipe,
      files: found.files?.length ? found.files : seed.files,
      ...(found.packs ?? seed.packs ? { packs: found.packs ?? seed.packs } : {}),
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
    } else if ((!existing.validationRecipe && seed.validationRecipe) || (!existing.packs && seed.packs)) {
      await store.saveTreeType({
        ...existing,
        validationRecipe: existing.validationRecipe ?? seed.validationRecipe,
        files: existing.files?.length ? existing.files : seed.files,
        ...(seed.packs ? { packs: existing.packs ?? seed.packs } : {}),
      });
      updated++;
    }
  }
  return updated;
}
