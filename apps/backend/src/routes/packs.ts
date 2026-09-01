import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import { validatePack } from '../lib/packs.js';
import type { PersonaPack } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';
import { requireBudget, requirePrompt } from '../lib/pack-defaults.js';
import { validatePackValues, mergeValues } from '../lib/derived-packs.js';
import { validateScope } from '../lib/personas.js';
import type { PersonaPackService } from '../services/PersonaPackService.js';
import { ToolService } from '../services/ToolService.js';

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

  /** What this account may grant: its own catalogue, so a custom tool is grantable too. */
  const toolNames = async (userId: string) =>
    (await new ToolService(db).list(userId)).map((t) => t.name);
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
    const { slug, name, description, personaId, tools, mcp, workspace, sampling, budget, prompt } = req.body ?? {};

    const existing = await packs.visiblePacks(userId);
    const personas = await packs.referenceablePersonas(userId);
    const refusal = validatePack({ slug, name, personaId, tools }, existing, personas, undefined, await toolNames(userId));
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
      ...(Array.isArray(mcp) ? { mcp: mcp.map(String) } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
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
    const badScope = validateScope(pack.workspace);
    if (badScope) return res.status(400).json({ error: badScope });

    await db.savePersonaPack(pack);
    res.status(201).json(pack);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const existing = await packs.visiblePacks(userId);
    const pack = existing.find((p) => p.id === idOf(req) || p.slug === idOf(req));
    if (!pack) return res.status(404).json({ error: 'No such pack' });

    const { slug, name, description, personaId, tools, mcp, workspace, sampling, budget, prompt, model } = req.body ?? {};
    const personas = await packs.referenceablePersonas(userId);
    const candidate = {
      slug: slug === undefined ? pack.slug : String(slug),
      name: name === undefined ? pack.name : String(name),
      personaId: personaId === undefined ? pack.personaId : String(personaId),
      tools: tools === undefined ? pack.tools : tools,
    };
    // Only what this request actually sets. Re-checking an untouched grant list would make a pack
    // that already names a since-retired tool impossible to edit -- including to fix that name.
    const refusal = validatePack(
      candidate, existing, personas, pack.id,
      tools === undefined ? undefined : await toolNames(userId),
    );
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
      ...(Array.isArray(mcp) ? { mcp: mcp.map(String) } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...mergeValues(pack, { sampling, budget, prompt, model }),
      updatedAt: new Date().toISOString(),
    };
    const badValue = validatePackValues(updated);
    if (badValue) return res.status(400).json({ error: badValue });
    const badScope = validateScope(updated.workspace);
    if (badScope) return res.status(400).json({ error: badScope });

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
