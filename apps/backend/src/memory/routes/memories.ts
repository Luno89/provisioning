import { Router, type Request } from 'express';
import { asyncRoute, type Database, isRecord, requireAllowed } from '../../platform/index.js';
import { v4 as uuidv4 } from 'uuid';
import { unreachableMemory, type MemoryItem } from '../lib/memory-store.js';
import { memoryCategoryIn, memoryChangesIn } from '../lib/memory-input.js';
import type { TemporalBridge } from '../../infrastructure/index.js';
import { isToolNote } from '../../engine/index.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const modelIn = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const bodyOf = (req: Request): Record<string, unknown> => {
  const body: unknown = req.body;
  return isRecord(body) ? body : {};
};

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface MemoriesRouterDeps {
  db: Database;
  temporalBridge: Pick<TemporalBridge, 'lastConsolidation'>;
}

export function memoriesRouter(deps: MemoriesRouterDeps): Router {
  const { db, temporalBridge } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const memories = await db.memory.getMemories(ownerId);
    res.json(memories.filter((memory) => !isToolNote(memory)));
  }));

  router.get('/consolidation', requireAllowed('administer', { kind: 'install' }), asyncRoute(async (_req, res) => {
    res.json(temporalBridge.lastConsolidation ?? null);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const body = bodyOf(req);
    const model = modelIn(body.model);
    const category = memoryCategoryIn(body.category);
    if (!body.category || !body.title || !body.text) {
      return res.status(400).json({ error: 'category, title, and text are required' });
    }
    if (!category) return res.status(400).json({ error: `${String(body.category)} is not a kind of memory` });
    const item: MemoryItem = {
      id: uuidv4(),
      ownerId,
      ...(body.projectId ? { projectId: String(body.projectId) } : {}),
      category,
      ...(model ? { model } : {}),
      scope: body.scope === 'global' ? 'global' : 'project',
      recommendedScope: body.recommendedScope === 'global' ? 'global' : 'project',
      status: body.status === 'pending_review' ? 'pending_review' : 'active',
      source: 'manual',
      title: String(body.title).trim(),
      text: String(body.text).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const unreachable = unreachableMemory(item);
    if (unreachable) return res.status(400).json({ error: unreachable });

    await db.memory.saveMemory(item);
    res.status(201).json(item);
  }));

  router.put('/:id/approve', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.memory.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    await db.memory.saveMemory(updated);
    res.json(updated);
  }));

  router.put('/:id/promote', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.memory.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      scope: 'global',
      updatedAt: new Date().toISOString(),
    };
    await db.memory.saveMemory(updated);
    res.json(updated);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.memory.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const body = bodyOf(req);
    const changes = memoryChangesIn(body);
    if (typeof changes === 'string') return res.status(400).json({ error: changes });
    const { model: _model, projectId: _projectId, ...kept } = existing;
    const model = 'model' in body ? modelIn(body.model) : existing.model;
    const { projectId, ...changed } = changes;
    const project = projectId === undefined ? existing.projectId : projectId ?? undefined;
    const updated: MemoryItem = {
      ...kept,
      ...(model ? { model } : {}),
      ...(project !== undefined ? { projectId: project } : {}),
      ...changed,
      updatedAt: new Date().toISOString(),
    };
    await db.memory.saveMemory(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id;
    const existing = (await db.memory.getMemories(ownerId)).find((m) => m.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    await db.memory.deleteMemory(idOf(req));
    res.json({ deleted: true });
  }));
  return router;
}
