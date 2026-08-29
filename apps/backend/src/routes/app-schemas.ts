import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { APP_SETTINGS_SCHEMAS } from '../lib/app-schemas.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function appSchemasRouter(deps: Record<string, any>): Router {
  const router = Router();

  router.get('/:appType', async (req, res) => {
    const schema = APP_SETTINGS_SCHEMAS[req.params.appType];
    if (!schema) return res.status(404).json({ error: `No settings schema for app type "${req.params.appType}"` });
    return res.json(schema);
  });

  return router;
}
