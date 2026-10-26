import { sanitiseNamespaceName } from './projects.js';
import type { WorkspaceLanguage } from '../../engine/index.js';
import { DEFAULT_WORKSPACE_LANGUAGE, type WorkspaceImageSpec } from '../../engine/lib/workspace-image-seeds.js';
import type { PersonaEgressRule } from '@koala/harness-types';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';
import { sameSeededRow } from '../../platform/lib/seed-diff.js';
import { egressReachProblem, validateEgressRules } from '../../infrastructure/lib/egress-rules.js';
import { releasePathsProblem } from '../../releases/lib/release-paths.js';
import { releaseHowProblem, type ReleaseHow } from '../../releases/lib/release-run.js';
import { DECLARED_SOURCES, descriptionProblem, keyProblem, type DeclaredSource } from './secret-requests.js';

export const DEFAULT_GROVE_AGENT = 'grove';

export const groveAgentOf = (type: { agent?: string | undefined } | undefined): string => type?.agent || DEFAULT_GROVE_AGENT;

export interface TreeTypeFile {
  path: string;
  content: string;
  executable?: boolean | undefined;
}

export interface TreeTypeVersion {
  version: string;
  language: WorkspaceLanguage;
  vars?: Record<string, string> | undefined;
}

export interface TreeTypeVersions {
  of: string;
  choices: TreeTypeVersion[];
  default: string;
}

export interface TreeTypeSecret {
  key: string;
  source: DeclaredSource;
  describe: string;
  signInAs?: string | undefined;
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
  secrets?: TreeTypeSecret[] | undefined;
  releaseWhen?: string[] | undefined;
  release?: ReleaseHow | undefined;
  agent?: string | undefined;
  versions?: TreeTypeVersions | undefined;
}

type VersionedType = Pick<TreeTypeSpec, 'language' | 'versions'>;

export function versionsProblem(images: readonly WorkspaceImageSpec[], versions: unknown): string | null {
  if (versions === undefined) return null;
  const candidate = versions as Partial<TreeTypeVersions> | null;
  if (!candidate || typeof candidate !== 'object') return 'versions must be {of, choices, default}.';
  if (typeof candidate.of !== 'string' || !candidate.of.trim()) return 'versions must say what they are versions of.';
  if (!Array.isArray(candidate.choices) || candidate.choices.length === 0) return 'versions needs at least one choice.';
  const seen = new Set<string>();
  for (const choice of candidate.choices as Partial<TreeTypeVersion>[]) {
    if (typeof choice?.version !== 'string' || !choice.version.trim()) return 'Each version needs a version.';
    if (seen.has(choice.version)) return `Version ${choice.version} is listed twice.`;
    seen.add(choice.version);
    if (!images.some((image) => image.id === choice.language)) return `Version ${choice.version} must work in one of ${images.map((image) => image.id).join(', ')}.`;
    if (choice.vars !== undefined && (typeof choice.vars !== 'object' || choice.vars === null || Object.values(choice.vars).some((value) => typeof value !== 'string'))) return `Version ${choice.version}'s vars must be names with text values.`;
  }
  if (typeof candidate.default !== 'string' || !seen.has(candidate.default)) return 'The default version must be one of the choices.';
  return null;
}

export function treeVersion(type: VersionedType, tree: { version?: string | undefined } | undefined): string | undefined {
  const choices = type.versions?.choices ?? [];
  return choices.find((choice) => choice.version === tree?.version)?.version
    ?? choices.find((choice) => choice.language === type.language)?.version;
}

export function treeLanguage(type: VersionedType, tree: { version?: string | undefined } | undefined): WorkspaceLanguage {
  return type.versions?.choices.find((choice) => choice.version === tree?.version)?.language ?? type.language;
}

export function versionForNewTree(type: VersionedType, wanted: string | undefined): { ok: true; version?: string } | { ok: false; error: string } {
  if (!type.versions) return wanted ? { ok: false, error: 'This type has no versions to choose from.' } : { ok: true };
  if (!wanted) return { ok: true, version: type.versions.default };
  if (type.versions.choices.some((choice) => choice.version === wanted)) return { ok: true, version: wanted };
  return { ok: false, error: `${type.versions.of} ${wanted} is not offered; choose ${type.versions.choices.map((choice) => choice.version).join(' or ')}.` };
}

export function secretsProblem(secrets: unknown): string | null {
  if (secrets === undefined) return null;
  if (!Array.isArray(secrets)) return 'secrets must be a list of {key, source, describe}.';
  const seen = new Set<string>();
  for (const entry of secrets as Partial<TreeTypeSecret>[]) {
    const key = typeof entry?.key === 'string' ? entry.key : '';
    const badKey = keyProblem(key);
    if (badKey) return badKey;
    if (seen.has(key)) return `${key} is declared twice.`;
    seen.add(key);
    if (!DECLARED_SOURCES.includes(entry.source as DeclaredSource)) return `${key} must come from one of ${DECLARED_SOURCES.join(', ')}.`;
    const badDescription = descriptionProblem(typeof entry.describe === 'string' ? entry.describe.trim() : '');
    if (badDescription) return `${key}: ${badDescription}.`;
    if (entry.signInAs !== undefined && (typeof entry.signInAs !== 'string' || !entry.signInAs.trim())) return `${key}: signInAs names the login this password signs in as.`;
  }
  return null;
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

  const badSecrets = secretsProblem(candidate.secrets);
  if (badSecrets) return badSecrets;

  const badPaths = releasePathsProblem(candidate.releaseWhen);
  if (badPaths) return badPaths;

  const badRelease = releaseHowProblem(candidate.release);
  if (badRelease) return badRelease;

  const badVersions = versionsProblem(images, candidate.versions);
  if (badVersions) return badVersions;

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
  version?: string | undefined;
  [name: string]: string | undefined;
}

export function versionVars(type: VersionedType, tree: { version?: string | undefined } | undefined): Record<string, string> {
  const version = treeVersion(type, tree);
  const choice = type.versions?.choices.find((entry) => entry.version === version);
  return version ? { ...(choice?.vars ?? {}), version } : {};
}

export function renderStarterFiles(files: readonly TreeTypeFile[], vars: StarterVars): TreeTypeFile[] {
  const fill = (text: string) => text.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => { const value = vars[key]; return value === undefined ? whole : value; },
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

export const NO_PARTICULAR_LANGUAGE = 'base';

export const builtLanguage = (language: WorkspaceLanguage): WorkspaceLanguage =>
  (language === NO_PARTICULAR_LANGUAGE ? DEFAULT_WORKSPACE_LANGUAGE : language);

export function treeLanguageFrom(store: {
  getTrees(): Promise<{ id: string; ownerId?: string | undefined; type?: string | undefined; version?: string | undefined }[]>;
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
}): (ownerId: string, treeId: string) => Promise<string | undefined> {
  return async (ownerId, treeId) => {
    const tree = (await store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    const type = await resolveTreeType(store, ownerId, tree?.type);
    const language = type ? treeLanguage(type, tree) : undefined;
    return language === NO_PARTICULAR_LANGUAGE ? undefined : language;
  };
}

export interface TreeWorkspaceExtras {
  env: { name: string; value: string }[];
  egress: ({ cidr: string; ports?: number[] } | { namespace: string; ports?: number[] })[];
}

export function dependencyNamespaceFrom(store: {
  getDeployments(): Promise<{ ownerId?: string | undefined; name: string; namespace?: string | undefined }[]>;
}): (ownerId: string, service: string) => Promise<string | undefined> {
  return async (ownerId, service) => {
    const wanted = sanitiseNamespaceName(service);
    const found = (await store.getDeployments()).find((entry) => entry.ownerId === ownerId && (entry.name === service || sanitiseNamespaceName(entry.name) === wanted));
    return found ? found.namespace || sanitiseNamespaceName(found.name) : undefined;
  };
}

export function ownNamespacesFrom(store: {
  getDeployments(): Promise<{ ownerId?: string | undefined; name: string; namespace?: string | undefined }[]>;
}): (ownerId: string) => Promise<ReadonlySet<string>> {
  return async (ownerId) => new Set((await store.getDeployments())
    .filter((entry) => entry.ownerId === ownerId)
    .map((entry) => entry.namespace || sanitiseNamespaceName(entry.name)));
}

export function treeExtrasFrom(
  store: {
    getTrees(): Promise<{ id: string; ownerId?: string | undefined; type?: string | undefined }[]>;
    getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  },
  namespaceOf: (ownerId: string, service: string) => Promise<string | undefined>,
  ownNamespaces: (ownerId: string) => Promise<ReadonlySet<string>>,
): (ownerId: string, treeId: string) => Promise<TreeWorkspaceExtras | undefined> {
  return async (ownerId, treeId) => {
    const tree = (await store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    const type = await resolveTreeType(store, ownerId, tree?.type);
    if (!type) return undefined;
    const refused = type.egress?.length ? egressReachProblem(type.egress, await ownNamespaces(ownerId)) : undefined;
    if (refused) throw new Error(`the tree type ${type.id} opens a network rule its workspace may not have: ${refused}`);
    const ports = (rule: { ports?: number[] | undefined }) => (rule.ports?.length ? { ports: [...rule.ports] } : {});
    const own = (type.egress ?? []).flatMap((rule): TreeWorkspaceExtras['egress'] => (rule.cidr
      ? [{ cidr: rule.cidr, ...ports(rule) }]
      : rule.namespace ? [{ namespace: rule.namespace, ...ports(rule) }] : []));
    const services = (await Promise.all((type.defaultBindings ?? []).map((service) => namespaceOf(ownerId, service))))
      .filter((namespace): namespace is string => Boolean(namespace))
      .map((namespace) => ({ namespace }));
    return { env: (type.env ?? []).map((entry) => ({ name: entry.name, value: entry.value })), egress: [...own, ...services] };
  };
}

export async function treeTypeOfProject(
  store: { getTrees(): Promise<{ id: string; ownerId?: string | undefined; type?: string | undefined; projectIds?: string[] | undefined }[]>; getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> },
  project: { id: string; ownerId?: string | undefined },
): Promise<TreeTypeSpec | undefined> {
  if (!project.ownerId) return undefined;
  const tree = (await store.getTrees()).find((entry) => entry.ownerId === project.ownerId && entry.projectIds?.[0] === project.id);
  return tree ? resolveTreeType(store, project.ownerId, tree.type) : undefined;
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
): { id: string; label: string; summary: string; agent?: string | undefined; versions?: VersionChoices | undefined }[] {
  return treeTypesFor(rows, ownerId).map((type) => ({
    id: type.id,
    label: type.label,
    summary: type.summary,
    ...(type.agent ? { agent: type.agent } : {}),
    ...(type.versions ? { versions: versionChoices(type.versions) } : {}),
  }));
}

export interface VersionChoices {
  of: string;
  choices: string[];
  default: string;
}

export const versionChoices = (versions: TreeTypeVersions): VersionChoices =>
  ({ of: versions.of, choices: versions.choices.map((choice) => choice.version), default: versions.default });

export const versionsLine = (versions: VersionChoices): string =>
  `${versions.of} ${versions.choices.map((choice) => (choice === versions.default ? `${choice} (the default)` : choice)).join(' or ')}`;

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

export interface TreeVersionStore {
  getTrees(): Promise<{ id: string; ownerId: string; type: string; version?: string | undefined }[]>;
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTree(tree: never): Promise<void>;
}

export async function stampTreeVersions(store: TreeVersionStore): Promise<number> {
  let stamped = 0;
  for (const tree of await store.getTrees()) {
    if (tree.version) continue;
    const type = await resolveTreeType(store, tree.ownerId, tree.type);
    const version = type ? treeVersion(type, tree) : undefined;
    if (!version) continue;
    await store.saveTree({ ...tree, version } as never);
    stamped++;
  }
  return stamped;
}
