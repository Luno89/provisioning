import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database, BindingTypeRecord } from '../lib/db-interface.js';
import { seedBindingTypes } from '../lib/binding-type-seeds.js';

export interface BindingTypesRouterDeps {
  db: Pick<Database, 'getBindingTypes' | 'saveBindingType' | 'deleteBindingType'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '').trim();

export function validateBindingType(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return 'Binding type must be an object';
  const c = candidate as Partial<BindingTypeRecord>;
  if (!c.id || typeof c.id !== 'string' || !/^[a-z0-9-_]+$/i.test(c.id)) {
    return 'id must be a non-empty alphanumeric string (hyphens/underscores allowed)';
  }
  if (!c.label || typeof c.label !== 'string') {
    return 'label must be a non-empty string';
  }
  if (c.defaultPort !== undefined && (typeof c.defaultPort !== 'number' || c.defaultPort <= 0 || c.defaultPort > 65535)) {
    return 'defaultPort must be a valid TCP port number (1-65535)';
  }
  if (c.protocol !== undefined && !['http', 'https', 'tcp', 'grpc'].includes(c.protocol)) {
    return 'protocol must be one of http, https, tcp, grpc';
  }
  return null;
}

export function bindingTypesRouter(
  deps: BindingTypesRouterDeps | Pick<Database, 'getBindingTypes' | 'saveBindingType' | 'deleteBindingType'>,
): Router {
  const db = 'db' in deps ? deps.db : deps;
  const router = Router();

  router.get('/', asyncRoute(async (_req, res) => {
    await seedBindingTypes(db).catch((err: Error) =>
      console.warn(`[binding-types] could not seed: ${err.message}`),
    );
    res.json(await db.getBindingTypes());
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const id = idOf(req);
    const candidate: BindingTypeRecord = {
      ...(req.body ?? {}),
      id,
    };

    const invalid = validateBindingType(candidate);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveBindingType(candidate);
    res.json({ ok: true, bindingType: candidate });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const id = idOf(req);
    if (!id) return res.status(400).json({ error: 'id required' });
    await db.deleteBindingType(id);
    res.json({ ok: true });
  }));

  return router;
}
