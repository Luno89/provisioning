import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { withBuiltIns } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { validatePersona } from '../lib/personas.js';
import type { Persona } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface PersonasRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
}

export function personasRouter(deps: PersonasRouterDeps): Router {
  const { db, modelIdsFor } = deps;
  const router = Router();

  const ownedPersonas = async (userId: string) =>
    withBuiltIns(await db.getPersonas(), userId, (p) => p.name);

  router.get('/', async (req, res) => {
    res.json(await ownedPersonas(userOf(req).id));
  });

  router.post('/', async (req, res) => {
    const userId = userOf(req).id;
    const { name, description, systemPrompt, basedOn } = req.body ?? {};

    const existing = await ownedPersonas(userId);
    const refusal = validatePersona({ name: String(name ?? ''), systemPrompt }, existing);
    if (refusal) return res.status(400).json({ error: refusal });


    const now = new Date().toISOString();
    const persona: Persona = {
      id: uuidv4(),
      ownerId: userId,
      name: String(name).trim(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt ? { systemPrompt: String(systemPrompt) } : {}),
      ...(basedOn ? { basedOn: String(basedOn) } : {}),
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

    const { name, description, systemPrompt, basedOn } = req.body ?? {};
    const nextName = name === undefined ? persona.name : String(name);
    const refusal = validatePersona({ name: nextName, systemPrompt }, existing, persona.id);
    if (refusal) return res.status(400).json({ error: refusal });

    const updated: Persona = {
      ...persona,
      name: nextName.trim(),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
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
