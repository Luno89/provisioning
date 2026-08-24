import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { v4 as uuidv4 } from 'uuid';
import { unreachableMemory, type MemoryItem } from '../../lib/memory-store.js';
import type { TemporalBridge } from '../../services/TemporalBridge.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The memory bank — what the harness remembers between runs, and the review gate over it.
 *
 * Extracted from index.ts, where `/api/harness/*` was 34 routes on one `app` object.
 */
export interface memoriesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
}

export function memoriesRouter(deps: memoriesRouterDeps): Router {
  const { db, temporalBridge } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const ownerId = userOf(req).id;
    const memories = await db.getMemories(ownerId);
    res.json(memories);
  });

  /**
   * What the last consolidation pass did.
   *
   * A loop that retires memories unattended should be visible to the person whose memories they
   * are — otherwise the bank quietly shrinking is indistinguishable from the bank being broken.
   */
  router.get('/consolidation', async (_req, res) => {
    res.json(temporalBridge.lastConsolidation ?? null);
  });

  router.post('/', async (req, res) => {
    const ownerId = userOf(req).id;
    const { category, title, text, projectId, scope, recommendedScope, status } = req.body;
    if (!category || !title || !text) {
      return res.status(400).json({ error: 'category, title, and text are required' });
    }
    const item: MemoryItem = {
      id: uuidv4(),
      ownerId,
      // Omitted rather than set to undefined: `exactOptionalPropertyTypes` distinguishes the two,
      // and so does Mongo — an explicit undefined is a stored key, not an absent one.
      ...(projectId ? { projectId: String(projectId) } : {}),
      category,
      scope: scope === 'global' ? 'global' : 'project',
      recommendedScope: recommendedScope === 'global' ? 'global' : 'project',
      status: status === 'pending_review' ? 'pending_review' : 'active',
      source: 'manual',
      title: String(title).trim(),
      text: String(text).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Refused here as well as swept by the consolidation loop — see `unreachableMemory`.
    const unreachable = unreachableMemory(item);
    if (unreachable) return res.status(400).json({ error: unreachable });

    await db.saveMemory(item);
    res.status(201).json(item);
  });

  router.put('/:id/approve', async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  router.put('/:id/promote', async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      scope: 'global',
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  router.put('/:id', async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const { category, title, text, scope, status, projectId } = req.body;
    const updated: MemoryItem = {
      ...existing,
      ...(category ? { category } : {}),
      ...(title ? { title: String(title).trim() } : {}),
      ...(text ? { text: String(text).trim() } : {}),
      ...(scope ? { scope } : {}),
      ...(status ? { status } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  router.delete('/:id', async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    await db.deleteMemory(idOf(req));
    res.json({ deleted: true });
  });
  return router;
}
