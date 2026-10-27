import { Router } from 'express';
import { temporalJwks } from '../lib/temporal-auth.js';

export function temporalKeysRouter(deps: { temporalKey: string }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(temporalJwks(deps.temporalKey));
  });
  return router;
}
