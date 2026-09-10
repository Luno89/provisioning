import { Router, type Request } from 'express';
import { getModelRateLimiterSnapshot } from '../../lib/model-rate-limiter.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function rateLimitsRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(getModelRateLimiterSnapshot(userOf(req).id));
  });

  return router;
}
