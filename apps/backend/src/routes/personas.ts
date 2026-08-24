import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { validatePersona, validateScope, resolveConfig } from '../lib/personas.js';
import { validateOverrides } from '../lib/tunables.js';
import type { Persona } from '@koala/harness-types';
import type { Database } from '../lib/db-interface.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Personas: named configurations you pick, rather than knobs you set every time.
 *
 * A persona is a complete environment — its tools, its egress, its image, its budgets — which is
 * why `personaWorkspace` can build a sandbox from one and nothing has to be passed alongside it.
 */
export interface PersonasRouterDeps {
  db: Database;
  modelIdsFor: (userId: string) => Promise<string[] | undefined>;
  /**
   * Seeds the built-in personas for a user who has none.
   *
   * Injected rather than imported: it lives beside `ensureKoala` in bootstrap because both only
   * ever ADD — a migration that overwrites a deliberate setting is worse than one that never ran —
   * and that rule is easier to keep in one place than in two.
   */
  ensurePersonas: (userId: string) => Promise<unknown>;
}

export function personasRouter(deps: PersonasRouterDeps): Router {
  const { db, modelIdsFor, ensurePersonas } = deps;
  const router = Router();

  /** Ownership filter, from `lib/ownership.ts`. */
  const ownedPersonas = async (userId: string) => ownedBy(await db.getPersonas(), userId);

  router.get('/', async (req, res) => {
    // The list is where a new user first needs them, and where their absence is most visible.
    await ensurePersonas(userOf(req).id);
    res.json(await ownedPersonas(userOf(req).id));
  });

  router.post('/', async (req, res) => {
    const userId = userOf(req).id;
    const { name, description, systemPrompt, overrides, scope, basedOn } = req.body ?? {};

    const existing = await ownedPersonas(userId);
    const refusal = validatePersona({ name: String(name ?? ''), systemPrompt }, existing);
    if (refusal) return res.status(400).json({ error: refusal });

    // The same registry check every other override bag gets. A persona is not a way around it —
    // and the layer matters now that `model` decides the run's context budget as well as its engine.
    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(overrides ?? {}, { layer: 'persona', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });
    // Same check the edit route applies: a scope decides what the sandbox can reach, and a
    // malformed rule fails in the direction that matters — the pod comes up and the policy does
    // not do what was meant.
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
      // A persona built on another inherits its prompt, sampling and scope — see Persona.basedOn.
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
    /**
     * Scope is editable now, which it was not.
     *
     * It carries the isolation — which tools exist, whether there is a repository, and the egress
     * rules that become the sandbox's NetworkPolicy — and all of it was fixed at seed time.
     * Widening one rule meant editing the seed script and re-running it.
     */
    const badScope = validateScope(scope);
    if (badScope) return res.status(400).json({ error: badScope });

    const updated: Persona = {
      ...persona,
      name: nextName.trim(),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
      // Merged onto the existing scope, not replacing it: an edit that sends only `egress` must
      // not silently drop the tool list.
      ...(scope !== undefined ? { scope: { ...(persona.scope ?? {}), ...scope } } : {}),
      ...(basedOn ? { basedOn: String(basedOn) } : {}),
      updatedAt: new Date().toISOString(),
    };
    /**
     * An empty string CLEARS the parent; omitting the field leaves it alone.
     *
     * Deleted rather than set to undefined — under exactOptionalPropertyTypes those are different,
     * and only one of them is what "no parent" looks like. A persona that could not be un-based
     * would be stuck inheriting a prompt somebody has since rewritten.
     */
    if (basedOn === '') delete (updated as { basedOn?: string }).basedOn;

    await db.savePersona(updated);
    res.json(updated);
  });

  router.delete('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const persona = (await ownedPersonas(userId)).find((p) => p.id === idOf(req));
    if (!persona) return res.status(404).json({ error: 'No such persona' });

    /**
     * Leaves keep their `personaId` after the persona is gone.
     *
     * Clearing it would rewrite the record of what a completed leaf ran under, which is the one
     * thing history must never do — the same reason a superseded profile is filed rather than
     * overwritten. A dangling id resolves to nobody and the leaf simply runs with no persona.
     */
    await db.deletePersona(persona.id);
    res.json({ deleted: true });
  });

  return router;
}
