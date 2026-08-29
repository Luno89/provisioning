import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { validateOverrides } from '../lib/tunables.js';
import { validatePack } from '../lib/packs.js';
import { seedPacks } from '../lib/pack-seeds.js';
import type { PersonaPack } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Packs: how something runs, as a record you can edit.
 *
 * ── WHY THIS IS SERVED AND NOT COMPILED IN ──
 * The pack list lived in two places that disagreed: a `const REGISTRY` of two on the server, and a
 * hardcoded array of three in `ChatSurface`. The extra one, `researcher`, had never existed
 * anywhere, so selecting it threw out of `getPersonaPack` and returned a 500 that named neither
 * list. Serving the catalogue is how the same problem was fixed for cluster providers, tree types
 * and persona options — see `persona-options.ts` for the argument in full.
 */
export interface PacksRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
  /**
   * Seeds the built-in personas for a user who has none.
   *
   * Packs point at personas, so a pack cannot be seeded before one exists. Injected rather than
   * imported for the same reason `personasRouter` takes it: it lives beside the other seeders in
   * bootstrap, where the ADDS-only rule is kept in one place.
   */
  ensurePersonas: (userId: string) => Promise<unknown>;
}

export function packsRouter(deps: PacksRouterDeps): Router {
  const { db, modelIdsFor, ensurePersonas } = deps;
  const router = Router();

  const ownedPacks = async (userId: string) => ownedBy(await db.getPersonaPacks(), userId);
  const ownedPersonas = async (userId: string) => ownedBy(await db.getPersonas(), userId);

  /**
   * The catalogue, and where a new user first gets one.
   *
   * Personas are seeded first because a pack resolves its persona by name at seed time and is
   * SKIPPED when that persona does not exist — seeding in the other order would quietly produce
   * an account with no packs at all.
   */
  router.get('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    await ensurePersonas(userId);
    await seedPacks(db, userId, uuidv4);
    res.json(await ownedPacks(userId));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const found = (await ownedPacks(userOf(req).id))
      .find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!found) return res.status(404).json({ error: 'No such pack' });
    res.json(found);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { slug, name, description, personaId, toolset, tools, permitted, overrides } = req.body ?? {};

    const existing = await ownedPacks(userId);
    const personas = await ownedPersonas(userId);
    const refusal = validatePack({ slug, name, personaId, toolset, tools, permitted }, existing, personas);
    if (refusal) return res.status(400).json({ error: refusal });

    // The same registry check every other override bag gets, at the pack layer — see `settableAt`.
    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(overrides ?? {}, { layer: 'pack', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });

    const now = new Date().toISOString();
    const pack: PersonaPack = {
      id: uuidv4(),
      ownerId: userId,
      slug: String(slug).trim(),
      name: String(name).trim(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
      personaId: String(personaId),
      toolset,
      tools: tools ?? [],
      permitted: permitted ?? ['read', 'propose'],
      overrides: overrides ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await db.savePersonaPack(pack);
    res.status(201).json(pack);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const existing = await ownedPacks(userId);
    const pack = existing.find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    const { slug, name, description, personaId, toolset, tools, permitted, overrides } = req.body ?? {};
    const personas = await ownedPersonas(userId);
    const candidate = {
      slug: slug === undefined ? pack.slug : String(slug),
      name: name === undefined ? pack.name : String(name),
      personaId: personaId === undefined ? pack.personaId : String(personaId),
      toolset: toolset === undefined ? pack.toolset : toolset,
      tools: tools === undefined ? pack.tools : tools,
      permitted: permitted === undefined ? pack.permitted : permitted,
    };
    const refusal = validatePack(candidate, existing, personas, pack.id);
    if (refusal) return res.status(400).json({ error: refusal });

    if (overrides !== undefined) {
      const models = await modelIdsFor(userId);
      const invalid = validateOverrides(overrides, { layer: 'pack', ...(models ? { models } : {}) });
      if (invalid) return res.status(400).json({ error: invalid });
    }

    const updated: PersonaPack = {
      ...pack,
      ...candidate,
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      /**
       * Overrides REPLACE rather than merge.
       *
       * The opposite of `scope` on a persona, deliberately: a scope edit sends one field and must
       * not drop the others, but an overrides bag is the complete set of knobs this pack sets, and
       * clearing one is done by omitting it. A merge would make a knob impossible to unset — you
       * could raise a temperature forever and never return it to the default.
       */
      ...(overrides !== undefined ? { overrides } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.savePersonaPack(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const pack = (await ownedPacks(userId)).find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });
    /**
     * A built-in is deletable, and comes back on the next catalogue read.
     *
     * Refusing would be the wrong shape: seeding ADDS what is missing, so "delete" already means
     * "reset to shipped" for a built-in, which is a useful thing to be able to do and the only
     * way back from an edit somebody regrets.
     */
    await db.deletePersonaPack(pack.id);
    res.json({ deleted: true });
  }));

  return router;
}
