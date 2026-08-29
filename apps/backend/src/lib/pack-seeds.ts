/**
 * The packs a user starts with — how each seeded persona runs.
 *
 * ── WHY A PACK IS NOT A CONSTANT ANY MORE ──
 * `lib/persona-pack.ts` held two packs in a `const REGISTRY`, and the frontend held a THIRD list
 * that did not match it: `ChatSurface` offered `researcher`, which the registry never had, so
 * choosing it threw out of `getPersonaPack` and returned a 500. A registry in code also meant a
 * pack could not be edited, which is the whole point of one — every knob it carries is something
 * you would want to tune and measure.
 *
 * So packs are rows. These seeds are a starting point, not the source: the same relationship
 * `PERSONA_SEEDS` has to personas, and `TREE_TYPE_SEEDS` to tree types.
 *
 * ── HOW A SEED FINDS ITS PERSONA ──
 * By NAME here, resolved to an id at seed time. A pack stores `personaId` — names are editable, so
 * a stored name silently re-points when somebody renames a persona — but a seed cannot know an id
 * that is generated per user, and the seeded persona's name is the one stable handle it has. The
 * name is used once, at seeding; everything afterwards is the id.
 */
import type { PersonaPack, PersonaScope, ToolEffect } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { PERSONA_SEEDS } from './persona-seeds.js';

/** A pack seed: everything but the identity fields the seeder fills in. */
export interface PackSeed {
  slug: string;
  name: string;
  description: string;
  /** Resolved to `personaId` at seed time. See the file docblock for why this one is a name. */
  personaName: string;
  toolset: PersonaPack['toolset'];
  tools: string[];
  permitted: ToolEffect[];
  overrides: PersonaPack['overrides'];
}

/**
 * Koala's tools, named rather than "everything the executor has".
 *
 * An empty list means "every tool this executor offers", which is what Koala effectively had —
 * `chat-pack.ts` handed it all of `KOALA_TOOLS` and never consulted a grant list at all. Naming
 * them makes the grant visible and editable, and makes the config drawer's switches mean
 * something: they had been writing to a field nothing read.
 */
const KOALA_TOOLS_GRANTED = [
  'propose_tree', 'propose_spec', 'add_project_dependency', 'list_trees',
  'get_project_pipeline', 'get_project_env', 'set_project_env', 'deploy_project', 'get_project_url',
  'get_logs', 'get_events', 'inspect_resources', 'cluster_capacity', 'list_infrastructure',
  'list_mcp_servers', 'enable_mcp_server',
  'request_escalated_privileges', 'request_secret', 'inject_secret_to_pod',
  'get_project_secret', 'set_project_secret', 'list_project_secrets',
  // Imported into KOALA_TOOLS from LEAF_TOOLS rather than restated — see koala-tools.ts:552 for
  // why, and for the one release in which they had handlers and no schema at all.
  'web_search', 'fetch_web_page',
];

/**
 * A pack for every WORK persona, derived from that persona's own scope.
 *
 * ── WHY THESE ARE DERIVED AND NOT WRITTEN OUT ──
 * The reason leaves had no pack is only that packs did not exist when leaves were built; the
 * environment they run in was already on the persona. So each work persona gets a pack that starts
 * as what that persona already declares, rather than a second hand-written copy of it which would
 * be wrong the first time either was edited.
 *
 * From here the two diverge on purpose: the PACK is what you edit and what the Lab varies, and the
 * persona keeps the prompt. That is the point of the split — "Builder, but with half the steps and
 * a different engine" becomes a second pack over one persona instead of a copied persona that
 * drifts.
 */
const WORK_PACKS: PackSeed[] = PERSONA_SEEDS
  .filter((p) => p.name !== KOALA_NAME)
  .map((p) => ({
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: p.name,
    description: p.description ?? '',
    personaName: p.name,
    // The agent loop in a pod, not either chat executor. See `PackToolset`.
    toolset: 'sandbox' as const,
    tools: [...(p.scope?.tools ?? [])],
    /**
     * A leaf writes: it commits, pushes, and creates records. `propose` is included because the
     * planning personas propose leaves, and `read` because everything reads.
     */
    permitted: ['read', 'write', 'propose'] as ToolEffect[],
    overrides: { ...(p.overrides ?? {}) },
  }));

export const PACK_SEEDS: PackSeed[] = [
  {
    slug: 'koala',
    name: 'Koala',
    description: 'General chat. Talks things through, operates projects, and proposes new builds.',
    personaName: KOALA_NAME,
    toolset: 'assistant',
    tools: KOALA_TOOLS_GRANTED,
    /**
     * Read, write AND propose — the honest set.
     *
     * The old pack declared `workflow: 'propose-only'`, which was never true: Koala holds
     * `deploy_project`, `set_project_env` and `inject_secret_to_pod`, all declared `write` in
     * `KOALA_TOOL_EFFECTS`. Since nothing read `workflow`, the false claim cost nothing and told
     * nobody anything. A declaration that is now enforced has to be accurate.
     */
    permitted: ['read', 'write', 'propose'],
    overrides: { temperature: 0.7 },
  },
  ...WORK_PACKS,
];

/** The store, narrowed to what seeding needs — same shape as `TreeTypeSeedStore`. */
export interface PackSeedStore {
  getPersonaPacks(): Promise<PersonaPack[]>;
  savePersonaPack(pack: PersonaPack): Promise<void>;
  getPersonas(): Promise<{ id: string; ownerId: string; name: string; scope?: PersonaScope }[]>;
}

/**
 * Gives an owner the shipped packs, once.
 *
 * ADDS only, never overwrites — the rule `ensurePersonas` states and the reason it gives: reverting
 * somebody's edited record every time they open the app is a failure they cannot even diagnose,
 * because the app undoes their fix silently. A pack whose persona cannot be resolved is SKIPPED
 * rather than written with a dangling id, since a pack pointing at nothing now refuses at runtime.
 */
export async function seedPacks(
  store: PackSeedStore,
  ownerId: string,
  newId: () => string,
): Promise<number> {
  const mine = (await store.getPersonaPacks()).filter((p) => p.ownerId === ownerId);
  const have = new Set(mine.map((p) => p.slug));
  const personas = (await store.getPersonas()).filter((p) => p.ownerId === ownerId);

  let added = 0;
  for (const seed of PACK_SEEDS) {
    if (have.has(seed.slug)) continue;
    const persona = personas.find((p) => p.name === seed.personaName);
    if (!persona) continue;

    const now = new Date().toISOString();
    await store.savePersonaPack({
      id: newId(),
      ownerId,
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      personaId: persona.id,
      toolset: seed.toolset,
      tools: [...seed.tools],
      permitted: [...seed.permitted],
      overrides: { ...seed.overrides },
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    });
    added++;
  }
  return added;
}
