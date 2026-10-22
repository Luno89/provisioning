import { Router } from 'express';
import { APP_SETTINGS_SCHEMAS } from '../lib/app-schemas.js';

export function appSchemasRouter(_deps: Record<string, any>): Router {
  const router = Router();

  router.get('/:appType', async (req, res) => {
    const schema = APP_SETTINGS_SCHEMAS[req.params.appType];
    if (!schema) return res.status(404).json({ error: `No settings schema for app type "${req.params.appType}"` });
    return res.json(schema);
  });

  return router;
}
