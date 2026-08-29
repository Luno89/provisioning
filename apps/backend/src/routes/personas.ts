import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { validatePersona, validateScope, resolveConfig } from '../lib/personas.js';
import { validateOverrides } from '../lib/tunables.js';
import type { Persona } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PersonasRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
  ensurePersonas: (userId: string) => Promise<unknown>;
}

export function personasRouter(deps: PersonasRouterDeps): Router {
  const { db, modelIdsFor, ensurePersonas } = deps;
  const router = Router();

  const ownedPersonas = async (userId: string) => ownedBy(await db.getPersonas(), userId);

  router.get('/', async (req, res) => {
    await ensurePersonas(userOf(req).id);
    res.json(await ownedPersonas(userOf(req).id));
  });

  router.post('/', async (req, res) => {
    const userId = userOf(req).id;
    const { name, description, systemPrompt, overrides, scope, basedOn } = req.body ?? {};

    const existing = await ownedPersonas(userId);
    const refusal = validatePersona({ name: String(name ?? ''), systemPrompt }, existing);
    if (refusal) return res.status(400).json({ error: refusal });

    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(overrides ?? {}, { layer: 'persona', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });
    const badScope = validateScope(scope);
    if (badScope) return res.status(400).json({ error: badScope });

    const now = new Date().toISOString();
    const persona: Persona = {
      id: uuidv4(),
      ownerId: userId,
      name: String(name).trim(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt ? { systemPrompt: String(systemPrompt) } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(basedOn ? { basedOn: String(basedOn) } : {}),
      overrides: overrides ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await db.savePersona(persona);
    res.status(201).json(persona);
  });

  router.put('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const existing = await ownedPersonas(userId);
    const persona = existing.find((p) => p.id === idOf(req));
    if (!persona) return res.status(404).json({ error: 'No such persona' });

    const { name, description, systemPrompt, overrides, scope, basedOn } = req.body ?? {};
    const nextName = name === undefined ? persona.name : String(name);
    const refusal = validatePersona({ name: nextName, systemPrompt }, existing, persona.id);
    if (refusal) return res.status(400).json({ error: refusal });
    if (overrides !== undefined) {
      const models = await modelIdsFor(userId);
      const invalid = validateOverrides(overrides, { layer: 'persona', ...(models ? { models } : {}) });
      if (invalid) return res.status(400).json({ error: invalid });
    }
    const badScope = validateScope(scope);
    if (badScope) return res.status(400).json({ error: badScope });

    const updated: Persona = {
      ...persona,
      name: nextName.trim(),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
      ...(scope !== undefined ? { scope: { ...(persona.scope ?? {}), ...scope } } : {}),
      ...(basedOn ? { basedOn: String(basedOn) } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (basedOn === '') delete (updated as { basedOn?: string }).basedOn;

    await db.savePersona(updated);
    res.json(updated);
  });

  router.delete('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const persona = (await ownedPersonas(userId)).find((p) => p.id === idOf(req));
    if (!persona) return res.status(404).json({ error: 'No such persona' });

    await db.deletePersona(persona.id);
    res.json({ deleted: true });
  });

  return router;
}
