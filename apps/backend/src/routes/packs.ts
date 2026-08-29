import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { withBuiltIns } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { validateOverrides } from '../lib/tunables.js';
import { validatePack } from '../lib/packs.js';
import type { PersonaPack } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PacksRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function packsRouter(deps: PacksRouterDeps): Router {
  const { db, modelIdsFor } = deps;
  const router = Router();

  const visiblePacks = async (userId: string) =>
    withBuiltIns(await db.getPersonaPacks(), userId, (p) => p.slug);

  const visiblePersonas = async (userId: string) =>
    withBuiltIns(await db.getPersonas(), userId, (p) => p.name);

  const findPack = async (userId: string, id: string) =>
    (await visiblePacks(userId)).find((p) => p.id === id || p.slug === id);

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await visiblePacks(userOf(req).id));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const found = await findPack(userOf(req).id, idOf(req));
    if (!found) return res.status(404).json({ error: 'No such pack' });
    res.json(found);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { slug, name, description, personaId, toolset, tools, permitted, overrides } = req.body ?? {};

    const existing = await visiblePacks(userId);
    const personas = await visiblePersonas(userId);
    const refusal = validatePack({ slug, name, personaId, toolset, tools, permitted }, existing, personas);
    if (refusal) return res.status(400).json({ error: refusal });

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
    const existing = await visiblePacks(userId);
    const pack = existing.find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    const { slug, name, description, personaId, toolset, tools, permitted, overrides } = req.body ?? {};
    const personas = await visiblePersonas(userId);
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

    const isBuiltIn = pack.ownerId === undefined;
    const updated: PersonaPack = {
      ...pack,
      ...candidate,
      ...(isBuiltIn ? { id: uuidv4(), ownerId: userId, builtIn: false, createdAt: new Date().toISOString() } : {}),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.savePersonaPack(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const pack = await findPack(userId, idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    if (pack.ownerId === undefined) {
      return res.status(409).json({
        error: `"${pack.name}" ships with the platform. Edit it to make your own version, `
          + 'or delete that version to go back to this one.',
      });
    }
    await db.deletePersonaPack(pack.id);
    res.json({ deleted: true, reset: true });
  }));

  return router;
}
