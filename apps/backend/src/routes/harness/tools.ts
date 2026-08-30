import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import { ToolService } from '../../services/ToolService.js';
import type { Database } from '../../lib/db-interface.js';
import { v4 as uuidv4 } from 'uuid';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface toolsRouterDeps {
  db: Database;
  
}

export function toolsRouter(deps: toolsRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const all = await new ToolService(db).list(userOf(req).id);
    if (category && category !== 'all') {
      return res.json(all.filter((t) => t.category === category));
    }
    res.json(all);
  });

  router.post('/', async (req, res) => {
    const { name, category, description, requiresBinaries, parameters, scriptCommand } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }
    const item = {
      id: uuidv4(),
      name: String(name).trim(),
      category: category || 'custom',
      description: String(description).trim(),
      requiresBinaries: Array.isArray(requiresBinaries) ? requiresBinaries : [],
      parameters: parameters || { type: 'object', properties: {} },
      scriptCommand: scriptCommand ? String(scriptCommand) : undefined,
      isBuiltIn: false,
    };
    await db.saveTool(item as any);
    res.status(201).json(item);
  });

  router.put('/:id', async (req, res) => {
    const existing = (await db.getTools()).find((t) => t.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such tool' });
    const { name, category, description, requiresBinaries, parameters, scriptCommand } = req.body;
    const updated = {
      ...existing,
      ...(name ? { name: String(name).trim() } : {}),
      ...(category ? { category } : {}),
      ...(description ? { description: String(description).trim() } : {}),
      ...(requiresBinaries ? { requiresBinaries: Array.isArray(requiresBinaries) ? requiresBinaries : [] } : {}),
      ...(parameters ? { parameters } : {}),
      ...(scriptCommand !== undefined ? { scriptCommand: String(scriptCommand) } : {}),
    };
    await db.saveTool(updated as any);
    res.json(updated);
  });

  router.delete('/:id', async (req, res) => {
    const existing = (await db.getTools()).find((t) => t.id === idOf(req));
    if (!existing) return res.status(404).json({ error: 'No such tool' });
    await db.deleteTool(idOf(req));
    res.json({ deleted: true });
  });

  return router;
}
