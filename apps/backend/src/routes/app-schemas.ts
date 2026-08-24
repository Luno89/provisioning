import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { APP_SETTINGS_SCHEMAS } from '../lib/app-schemas.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The settings schema for an app type, served rather than duplicated in the UI.
 */
export function appSchemasRouter(deps: Record<string, any>): Router {
  const router = Router();

  /**
   * Settings schema for app types whose configuration is schema-driven rather than a handful of
   * first-class fields (see lib/app-settings-schema.ts). The frontend's Config tab renders itself
   * from this, so a new setting is a one-file backend change with no matching UI edit.
   *
   * Served over HTTP rather than shared as a module because there is no cross-workspace source
   * package here — adding one would mean rebuilding the in-cluster worker image too.
   */
  router.get('/:appType', async (req, res) => {
    const schema = APP_SETTINGS_SCHEMAS[req.params.appType];
    if (!schema) return res.status(404).json({ error: `No settings schema for app type "${req.params.appType}"` });
    return res.json(schema);
  });

  return router;
}
