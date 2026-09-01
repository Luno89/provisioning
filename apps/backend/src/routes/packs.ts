import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import { validatePack } from '../lib/packs.js';
import type { PersonaPack } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';
import { requireBudget, requirePrompt } from '../lib/pack-defaults.js';
import { validatePackValues, mergeValues } from '../lib/derived-packs.js';
import type { PersonaPackService } from '../services/PersonaPackService.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PacksRouterDeps {
  db: Database;
  packs: PersonaPackService;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function packsRouter(deps: PacksRouterDeps): Router {
  const { db, modelIdsFor, packs } = deps;
  const router = Router();

  const findPack = async (userId: string, id: string) =>
    packs.resolvePack(userId, id);
  router.get('/', asyncRoute(async (req, res) => {
    res.json(await packs.visiblePacks(userOf(req).id));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const found = await findPack(userOf(req).id, idOf(req));
    if (!found) return res.status(404).json({ error: 'No such pack' });
    res.json(found);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { slug, name, description, personaId, tools, sampling, budget, prompt } = req.body ?? {};

    const existing = await packs.visiblePacks(userId);
    const personas = await packs.referenceablePersonas(userId);
    const refusal = validatePack({ slug, name, personaId, tools }, existing, personas);
    if (refusal) return res.status(400).json({ error: refusal });

    const now = new Date().toISOString();
    const template = existing.find((p) => p.builtIn) ?? existing[0];
    const pack: PersonaPack = {
      id: uuidv4(),
      ownerId: userId,
      slug: String(slug).trim(),
      name: String(name).trim(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
      personaId: String(personaId),
      tools: tools ?? [],
      /**
       * A new pack starts from what the shipped packs sample at, taken from the seeded row rather
       * than a constant — there is no module left to fall back to, and a pack with no sampler
       * would send none at all.
       */
      sampling: sampling ?? template?.sampling ?? { toolTurn: {}, conversation: {} },
      budget: budget ?? template?.budget ?? await requireBudget(db),
      prompt: prompt ?? template?.prompt ?? await requirePrompt(db),
      createdAt: now,
      updatedAt: now,
    };
    const badValue = validatePackValues(pack);
    if (badValue) return res.status(400).json({ error: badValue });

    await db.savePersonaPack(pack);
    res.status(201).json(pack);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const existing = await packs.visiblePacks(userId);
    const pack = existing.find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    const { slug, name, description, personaId, tools, sampling, budget, prompt, model } = req.body ?? {};
    const personas = await packs.referenceablePersonas(userId);
    const candidate = {
      slug: slug === undefined ? pack.slug : String(slug),
      name: name === undefined ? pack.name : String(name),
      personaId: personaId === undefined ? pack.personaId : String(personaId),
      tools: tools === undefined ? pack.tools : tools,
    };
    const refusal = validatePack(candidate, existing, personas, pack.id);
    if (refusal) return res.status(400).json({ error: refusal });

    const isBuiltIn = pack.ownerId == null;
    const updated: PersonaPack = {
      ...pack,
      ...candidate,
      ...(isBuiltIn ? { id: uuidv4(), ownerId: userId, builtIn: false, createdAt: new Date().toISOString() } : {}),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      /**
       * Deep-merged, so the editor can send one knob rather than the whole pack — which is what a
       * knob grid has to do, and what `overrides` used to make possible by sitting on top instead.
       */
      ...mergeValues(pack, { sampling, budget, prompt, model }),
      updatedAt: new Date().toISOString(),
    };
    const badValue = validatePackValues(updated);
    if (badValue) return res.status(400).json({ error: badValue });

    /**
     * An endpoint the account does not have would surface much later as "model not found" in the
     * middle of a run, so it is refused where it is set.
     */
    if (updated.model?.endpointId) {
      const models = await modelIdsFor(userId);
      if (models && !models.includes(updated.model.endpointId)) {
        return res.status(400).json({ error: `No model ${updated.model.endpointId}` });
      }
    }

    await db.savePersonaPack(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const pack = await findPack(userId, idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    if (pack.ownerId == null) {
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
