import type { WorkspaceLanguage } from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { PersonaEgressRule } from '@koala/harness-types';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';
import { validateEgressRules } from './personas.js';
import { renderCustomStepCommand, substituteTemplate, type CustomStepDefinition } from './custom-steps.js';
import { validateLeafWorkflowSpec, type LeafWorkflowSpec } from './leaf-workflow-types.js';
import type { VerdictPolicy } from './leaf-run-verdict.js';

export interface TreeTypeFile {
  path: string;
  content: string;
  executable?: boolean | undefined;
}

export const VALIDATION_CHECK_TYPES = [
  'file-exists', 'content-matches', 'run-command', 'http-probe', 'mcp-probe',
  'git-tracked', 'k8s-probe', 'wait-for', 'custom',
] as const;

export type ValidationCheckType = typeof VALIDATION_CHECK_TYPES[number];

export const K8S_PROBE_KINDS = ['pod', 'deployment', 'service'] as const;
export type K8sProbeKind = typeof K8S_PROBE_KINDS[number];

export interface ValidationCheckDefinition {
  id: string;
  name: string;
  description?: string | undefined;
  type: ValidationCheckType;
  target?: string | undefined;
  command?: string | undefined;
  pattern?: string | undefined;
  expectedStatus?: number | undefined;
  timeoutMs?: number | undefined;

  /** A failure is reported in the diagnostic output but doesn't fail the recipe. */
  optional?: boolean | undefined;
  /** id of an earlier check in this recipe that must have passed; unset means this check always runs. */
  runIf?: string | undefined;
  /** Re-attempt this one check up to N times, waiting retryDelayMs between attempts, before it counts as failed. */
  retries?: number | undefined;
  retryDelayMs?: number | undefined;

  /** k8s-probe only. */
  kind?: K8sProbeKind | undefined;
  namespace?: string | undefined;

  /**
   * wait-for only: which other check type to repeatedly attempt (using this same check's
   * target/command/pattern/expectedStatus/kind/namespace fields) until it passes or timeoutMs
   * elapses. Reuses the wrapped type's own fields rather than nesting a second check object, so a
   * wait-for step edits like any other typed step, just with polling added.
   */
  waitForType?: Exclude<ValidationCheckType, 'wait-for'> | undefined;
  /** wait-for only: how often to re-attempt the wrapped condition until timeoutMs elapses. */
  pollIntervalMs?: number | undefined;

  /** custom only: which CustomStepDefinition this step instance is. */
  customStepId?: string | undefined;
  /** custom only: values for the definition's declared fields, keyed by field key. */
  params?: Record<string, string | number | boolean> | undefined;
}

/**
 * A recipe's `checks` array holds a tree, not just leaf steps — a node is either a leaf
 * `ValidationCheckDefinition` (unchanged, discriminated by having no `containerType`) or a
 * `RecipeGroup`/`RecipeLoop` container. Every already-persisted recipe is already valid under this
 * type (a flat array of leaves, no `containerType` anywhere), so nothing needs migrating.
 */
export type RecipeNode = ValidationCheckDefinition | RecipeGroup | RecipeLoop;

export interface RecipeGroup {
  id: string;
  name: string;
  /** Discriminant — a leaf ValidationCheckDefinition never has this field. Deliberately not named
   * `kind`, which a leaf already uses for k8s-probe's resource kind. */
  containerType: 'group';
  children: RecipeNode[];
  /** Same meaning as a step's optional: a failing child is reported but doesn't fail the recipe. */
  optional?: boolean | undefined;
  /** Same meaning as a step's runIf: skip the whole group if the named earlier node didn't pass. */
  runIf?: string | undefined;
}

export const LOOP_TYPES = ['count', 'until', 'forEach'] as const;
export type LoopType = typeof LOOP_TYPES[number];

export interface RecipeLoop {
  id: string;
  name: string;
  containerType: 'loop';
  loopType: LoopType;
  children: RecipeNode[];
  optional?: boolean | undefined;
  runIf?: string | undefined;
  /** count: exact repeat count. until: a safety cap on attempts. Unused by forEach. */
  maxIterations?: number | undefined;
  /** until / forEach: overall wall-clock budget across every iteration. */
  timeoutMs?: number | undefined;
  /** forEach only: a shell command; each non-blank line of stdout becomes one iteration's `{{item}}`. */
  itemsCommand?: string | undefined;
}

export function isContainerNode(node: RecipeNode): node is RecipeGroup | RecipeLoop {
  return 'containerType' in node;
}

export function someRecipeLeaf(nodes: readonly RecipeNode[], predicate: (c: ValidationCheckDefinition) => boolean): boolean {
  return nodes.some((node) => (
    isContainerNode(node) ? someRecipeLeaf(node.children, predicate) : predicate(node)
  ));
}

export function flattenRecipeLeaves(nodes: readonly RecipeNode[]): ValidationCheckDefinition[] {
  return nodes.flatMap((node) => (isContainerNode(node) ? flattenRecipeLeaves(node.children) : [node]));
}

export interface ValidationRecipe {
  type: 'document' | 'command' | 'runtime-service';
  checks: RecipeNode[];
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
  leafWorkflow?: LeafWorkflowSpec | undefined;
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
  verdictPolicy?: VerdictPolicy | undefined;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_STARTER_FILES = 20;

/**
 * Walks a recipe's node tree depth-first, validating every leaf check (unchanged rules) and every
 * group/loop container. `seenIds` is one flat set shared across the whole recursion — `runIf` may
 * name any node visited earlier in depth-first document order, not just a same-level sibling, and a
 * container's own id is added before its children are validated (so a child can even runIf its own
 * parent, harmless and simpler than special-casing it away).
 */
function validateRecipeNodes(nodes: unknown, seenIds: Set<string>): string | null {
  if (!Array.isArray(nodes)) return 'validationRecipe.checks must be an array.';

  for (const raw of nodes) {
    const n = raw as Record<string, unknown>;
    if (!n || typeof n !== 'object') return 'Each recipe node must be an object.';
    if (!n.id || typeof n.id !== 'string') return 'Each node must have a string id.';
    if (!n.name || typeof n.name !== 'string') return 'Each node must have a string name.';

    if ('containerType' in n) {
      if (n.containerType !== 'group' && n.containerType !== 'loop') {
        return `Node "${n.id as string}": containerType must be "group" or "loop".`;
      }
      if (n.optional !== undefined && typeof n.optional !== 'boolean') {
        return `Node "${n.id as string}": optional must be true or false.`;
      }
      if (n.runIf !== undefined) {
        if (typeof n.runIf !== 'string' || !n.runIf.trim()) return `Node "${n.id as string}": runIf must be a node id.`;
        if (!seenIds.has(n.runIf)) {
          return `Node "${n.id as string}": runIf "${n.runIf}" must name an earlier node in the recipe.`;
        }
      }
      if (n.containerType === 'loop') {
        if (!(LOOP_TYPES as readonly string[]).includes(n.loopType as string)) {
          return `Node "${n.id as string}": loopType must be one of ${LOOP_TYPES.join(', ')}.`;
        }
        if (n.loopType === 'count' || n.loopType === 'until') {
          if (typeof n.maxIterations !== 'number' || !Number.isInteger(n.maxIterations) || n.maxIterations < 1) {
            return `Node "${n.id as string}": ${n.loopType} needs maxIterations to be a positive integer.`;
          }
        }
        if (n.loopType === 'forEach' && !(typeof n.itemsCommand === 'string' && n.itemsCommand.trim())) {
          return `Node "${n.id as string}": forEach needs itemsCommand.`;
        }
        if (n.timeoutMs !== undefined && (typeof n.timeoutMs !== 'number' || n.timeoutMs <= 0)) {
          return `Node "${n.id as string}": timeoutMs must be a positive number.`;
        }
      }
      seenIds.add(n.id);
      const err = validateRecipeNodes(n.children, seenIds);
      if (err) return err;
      continue;
    }

    const c = n as unknown as ValidationCheckDefinition;
    if (!(VALIDATION_CHECK_TYPES as readonly string[]).includes(c.type)) {
      return `Unknown check type "${c.type}" in validationRecipe.`;
    }
    if (c.retries !== undefined && (typeof c.retries !== 'number' || !Number.isInteger(c.retries) || c.retries < 0)) {
      return `Check "${c.id}": retries must be a non-negative integer.`;
    }
    if (c.retryDelayMs !== undefined && (typeof c.retryDelayMs !== 'number' || c.retryDelayMs < 0)) {
      return `Check "${c.id}": retryDelayMs must be a non-negative number.`;
    }
    if (c.optional !== undefined && typeof c.optional !== 'boolean') {
      return `Check "${c.id}": optional must be true or false.`;
    }
    if (c.runIf !== undefined) {
      if (typeof c.runIf !== 'string' || !c.runIf.trim()) return `Check "${c.id}": runIf must be a check id.`;
      if (!seenIds.has(c.runIf)) {
        return `Check "${c.id}": runIf "${c.runIf}" must name an earlier check in the same recipe.`;
      }
    }
    if (c.type === 'k8s-probe') {
      if (!c.kind || !(K8S_PROBE_KINDS as readonly string[]).includes(c.kind)) {
        return `Check "${c.id}": k8s-probe needs kind to be one of ${K8S_PROBE_KINDS.join(', ')}.`;
      }
      if (!c.namespace?.trim()) return `Check "${c.id}": k8s-probe needs a namespace.`;
    }
    if (c.type === 'wait-for') {
      const waitForType: string | undefined = c.waitForType;
      if (!waitForType || waitForType === 'wait-for' || !(VALIDATION_CHECK_TYPES as readonly string[]).includes(waitForType)) {
        return `Check "${c.id}": wait-for needs waitForType to name another check type.`;
      }
      if (c.pollIntervalMs !== undefined && (typeof c.pollIntervalMs !== 'number' || c.pollIntervalMs <= 0)) {
        return `Check "${c.id}": pollIntervalMs must be a positive number.`;
      }
      if (c.timeoutMs !== undefined && c.pollIntervalMs !== undefined && c.pollIntervalMs > c.timeoutMs) {
        return `Check "${c.id}": pollIntervalMs can't be larger than the check's own timeoutMs.`;
      }
    }
    if (c.type === 'custom' && !c.customStepId?.trim()) {
      return `Check "${c.id}": custom needs customStepId to name which custom step it is.`;
    }
    seenIds.add(c.id);
  }
  return null;
}

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
    const err = validateRecipeNodes(r.checks, new Set<string>());
    if (err) return err;
  }

  if (candidate.leafWorkflow) {
    const err = validateLeafWorkflowSpec(candidate.leafWorkflow);
    if (err) return err;
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

  if (candidate.verdictPolicy !== undefined) {
    const v = candidate.verdictPolicy;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'verdictPolicy must be an object.';
    if (v.requireVerify !== undefined && typeof v.requireVerify !== 'boolean') {
      return 'verdictPolicy.requireVerify must be true or false.';
    }
    if (v.requireArtifacts !== undefined && typeof v.requireArtifacts !== 'boolean') {
      return 'verdictPolicy.requireArtifacts must be true or false.';
    }
    if (v.combineMode !== undefined && v.combineMode !== 'all' && v.combineMode !== 'any') {
      return 'verdictPolicy.combineMode must be "all" or "any".';
    }
  }

  return null;
}

/**
 * Check types that need a live, deployed thing to probe — meaningless mid-leaf (the sandbox has no
 * cluster access), so they're stripped before a recipe is handed to the worker and left only for
 * final verification. A wait-for wrapping one of these is stripped too (leafValidationRecipe checks
 * both a check's own type and, for wait-for, what it wraps).
 */
const RUNTIME_PROBE_CHECK_TYPES = new Set<ValidationCheckDefinition['type']>(['mcp-probe', 'http-probe', 'k8s-probe']);

function isRuntimeProbeCheck(c: ValidationCheckDefinition): boolean {
  const wrapped = c.type === 'wait-for' ? c.waitForType : undefined;
  return RUNTIME_PROBE_CHECK_TYPES.has(c.type) || (wrapped !== undefined && RUNTIME_PROBE_CHECK_TYPES.has(wrapped));
}

function filterRecipeLeaves(nodes: RecipeNode[], keep: (c: ValidationCheckDefinition) => boolean): RecipeNode[] {
  const out: RecipeNode[] = [];
  for (const node of nodes) {
    if (isContainerNode(node)) {
      const children = filterRecipeLeaves(node.children, keep);
      if (children.length) out.push({ ...node, children });
    } else if (keep(node)) {
      out.push(node);
    }
  }
  return out;
}

export function leafValidationRecipe(recipe: ValidationRecipe | undefined): ValidationRecipe | undefined {
  if (!recipe) return recipe;
  const checks = filterRecipeLeaves(recipe.checks, (c) => !isRuntimeProbeCheck(c));
  return checks.length ? { ...recipe, checks } : undefined;
}

export function mapRecipeLeaves(nodes: RecipeNode[], fn: (c: ValidationCheckDefinition) => ValidationCheckDefinition): RecipeNode[] {
  return nodes.map((node) => (
    isContainerNode(node) ? { ...node, children: mapRecipeLeaves(node.children, fn) } : fn(node)
  ));
}

export function substituteRecipeNodesItem(nodes: RecipeNode[], item: string): RecipeNode[] {
  return mapRecipeLeaves(nodes, (c) => ({
    ...c,
    command: c.command !== undefined ? substituteTemplate(c.command, { item }) : c.command,
    target: c.target !== undefined ? substituteTemplate(c.target, { item }) : c.target,
    pattern: c.pattern !== undefined ? substituteTemplate(c.pattern, { item }) : c.pattern,
  }));
}

/**
 * Expands every `type: 'custom'` check (and any `wait-for` wrapping one) into an equivalent
 * `run-command` check, filling the definition's shell template from the step instance's `params`.
 * `UniversalValidatorService` never needs to know custom step definitions exist — this is the one
 * place that translates "genuinely custom step kind" into the mechanism every check type already
 * reduces to. A reference to a definition that no longer exists resolves to a check that always
 * fails with a clear message, rather than throwing or silently vanishing from the recipe.
 */
export function resolveCustomSteps(
  recipe: ValidationRecipe | undefined,
  definitions: readonly CustomStepDefinition[],
): ValidationRecipe | undefined {
  if (!recipe) return recipe;
  const byId = new Map(definitions.map((d) => [d.id, d]));

  const resolveOne = (c: ValidationCheckDefinition): ValidationCheckDefinition => {
    const def = c.customStepId ? byId.get(c.customStepId) : undefined;
    if (!def) {
      return {
        id: c.id, name: c.name, type: 'run-command',
        command: `echo "Custom step '${c.customStepId ?? '(none)'}' no longer exists." >&2; exit 1`,
      };
    }
    return {
      id: c.id, name: c.name, type: 'run-command',
      command: renderCustomStepCommand(def, c.params),
      timeoutMs: c.timeoutMs ?? def.timeoutMs,
    };
  };

  const checks = mapRecipeLeaves(recipe.checks, (c) => {
    if (c.type === 'custom') {
      const { optional, runIf, retries, retryDelayMs } = c;
      return { ...resolveOne(c), optional, runIf, retries, retryDelayMs };
    }
    if (c.type === 'wait-for' && c.waitForType === 'custom') {
      const resolved = resolveOne(c);
      return { ...c, waitForType: 'run-command' as const, command: resolved.command, timeoutMs: c.timeoutMs };
    }
    return c;
  });

  return { ...recipe, checks };
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
