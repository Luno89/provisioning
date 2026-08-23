/**
 * What a tree is producing, as a record rather than a union.
 *
 * ── WHY THIS MOVED OUT OF A CONSTANT ──
 * `lib/trees.ts` already argued for a registry: "A registry rather than a boolean or a set of
 * `if (type === 'x')` predicates scattered around. This codebase already learned that with cluster
 * providers: adding one used to mean twenty greps."
 *
 * It was right and it stopped half way. The table declared `language` and `produces` and NOTHING
 * read either, so the decisions they describe were made in three other places: on the persona, in
 * `templateFor`'s switch on type strings, and in a `producesCode` check. Three copies of one fact,
 * which is how a research tree ended up with an image that has no git — the persona chose it, and a
 * persona cannot know what the tree is producing.
 *
 * As records they are owned, editable and seeded, exactly like personas: adding a project type is a
 * form rather than a deploy, and no code branches on a type string.
 */
import { WORKSPACE_IMAGES, type WorkspaceLanguage } from './workspace-spec.js';
import { TREE_TYPE_SEEDS as TREE_TYPE_SEEDS_VALUE } from './tree-type-seeds.js';

/** A file a fresh repository starts with. Relative to the repository root, always. */
export interface TreeTypeFile {
  path: string;
  content: string;
}

export interface TreeTypeSpec {
  /** Stable slug. Lives in URLs and on every tree of this type, so it is not free text. */
  id: string;
  ownerId: string;
  label: string;
  /** One line, shown when picking. Says what the tree produces, not how it works. */
  summary: string;
  /**
   * The language the DELIVERABLE is written in, which decides the workspace image.
   *
   * The type decides, full stop — that is what makes it an opinionated template rather than a label.
   * A persona may still override it for its own work; the image is where work STARTS, not a limit on
   * the worker.
   */
  language: WorkspaceLanguage;
  /**
   * `service` deploys and must answer; `artefact` produces files that are read and never deployed.
   *
   * This is what decides whether finishing means a passing test suite or a document that says what
   * it promised. Not a persona flag: the same Builder writes code on one tree and a report on
   * another.
   */
  produces: 'service' | 'artefact';
  /** What finishing looks like, in the user's words. Shown on the tree, and seeds its acceptance. */
  doneMeans: string;
  /** The skeleton a fresh repository starts from. Empty is normal. */
  files: TreeTypeFile[];
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_STARTER_FILES = 12;

/**
 * Refuses a record that would fail later, in a place further from the mistake.
 *
 * Mirrors `validatePersona`: known shape, real values, and a message naming the field — a refusal
 * that does not say which field gets the same record back with different wording.
 */
export function validateTreeType(candidate: Partial<TreeTypeSpec>): string | null {
  if (!candidate.id || !SLUG.test(candidate.id)) {
    return 'id must be a slug: lowercase letters, numbers and single hyphens.';
  }
  if (!candidate.label?.trim()) return 'label is required.';
  if (!candidate.summary?.trim()) return 'summary is required.';
  if (!candidate.doneMeans?.trim()) return 'doneMeans is required — it is what acceptance starts from.';

  /**
   * Checked against the image catalogue, not against a list of names.
   *
   * A language with no image is a workspace that cannot be built, and the failure surfaces at pod
   * creation with nothing pointing back here.
   */
  if (!candidate.language || !(candidate.language in WORKSPACE_IMAGES)) {
    return `language must be one of ${Object.keys(WORKSPACE_IMAGES).join(', ')}.`;
  }
  if (candidate.produces !== 'service' && candidate.produces !== 'artefact') {
    return 'produces must be "service" or "artefact".';
  }

  const files = candidate.files ?? [];
  if (files.length > MAX_STARTER_FILES) return `A type may start from at most ${MAX_STARTER_FILES} files.`;
  for (const file of files) {
    /**
     * Relative, and inside the repository.
     *
     * These are written into a fresh repository by the platform. An absolute path or one climbing
     * out of it is a write somewhere nobody asked for, and it arrives from an editable record.
     */
    if (!file?.path || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      return `Starter file path ${JSON.stringify(file?.path ?? '')} must be relative and stay inside the repository.`;
    }
  }
  return null;
}

/** What a starter file may refer to. Kept small — a template is a skeleton, not a build system. */
export interface StarterVars {
  projectName: string;
  registryHost: string;
}

/**
 * Fills the placeholders in a type's starter files.
 *
 * ── WHY PLACEHOLDERS RATHER THAN FUNCTIONS ──
 * The old templates were functions — `NODE_PACKAGE(name)`, `nodeBaseImage(registryHost)` — which
 * works for a constant and cannot work for a record. A type that is editable in the Lab has to be
 * able to say "the project's name goes here" as data.
 *
 * An unknown token is left standing rather than replaced with `undefined`: these records are edited
 * by people, so a typo is expected, and writing the word "undefined" into a Dockerfile is a broken
 * build with nothing pointing at the cause.
 */
export function renderStarterFiles(files: readonly TreeTypeFile[], vars: StarterVars): TreeTypeFile[] {
  const fill = (text: string) => text.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => (key in vars ? String(vars[key as keyof StarterVars]) : whole),
  );
  return files.map((f) => ({ path: fill(f.path), content: fill(f.content) }));
}

/** The store, narrowed to what resolution needs. */
export interface TreeTypeStore {
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
}

/**
 * The type record for a tree, or nothing.
 *
 * Ownership-scoped like every other lookup here, and returning undefined rather than a default: a
 * type that does not resolve is a stale reference, and quietly substituting another one would build
 * the wrong workspace without saying so.
 */
export async function resolveTreeType(
  store: TreeTypeStore,
  ownerId: string,
  id: string | undefined,
): Promise<TreeTypeSpec | undefined> {
  if (!id) return undefined;
  const all = await store.getTreeTypes(ownerId).catch(() => [] as TreeTypeSpec[]);
  return all.find((t) => t.id === id && t.ownerId === ownerId);
}

/** Seeds, in the relationship `PERSONA_SEEDS` has to personas: a starting point, not the source. */
export type TreeTypeSeed = Omit<TreeTypeSpec, 'ownerId'>;

export { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

/** The store, narrowed to what seeding needs. */
export interface TreeTypeSeedStore extends TreeTypeStore {
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
}

/**
 * Gives an owner the shipped types, once.
 *
 * ── ADD ONLY, AND THAT IS THE FEATURE ──
 * Mirrors `ensurePersonas`. A type edited in the Lab has to survive the next boot or "editable" is
 * a lie, so an id the owner already has is skipped whatever it now contains — `ensureKoala` states
 * the rule and the reason: "a migration that overwrites a deliberate setting is worse than one that
 * never ran."
 *
 * Skipping per-ID rather than "do nothing if they have any" so a type shipped later still arrives
 * for someone who has been here since before it existed.
 */
export async function seedTreeTypes(store: TreeTypeSeedStore, ownerId: string): Promise<number> {
  const mine = await store.getTreeTypes(ownerId).catch(() => [] as TreeTypeSpec[]);
  const have = new Set(mine.map((t) => t.id));

  let added = 0;
  for (const seed of TREE_TYPE_SEEDS_VALUE) {
    if (have.has(seed.id)) continue;
    await store.saveTreeType({ ...seed, ownerId });
    added++;
  }
  return added;
}
