import { Router, type RequestHandler } from 'express';
import { asyncRoute } from './async-route.js';

const KINDS = ['cut-over', 'discard'] as const;

export function notesRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => { res.json([]); });
  return router;
}

export function itemsRouter(): Router {
  const router = Router();
  router.get('/:id', asyncRoute(async (req, res) => { res.json({ id: req.params.id }); }));
  for (const kind of KINDS) router.post(`/:id/${kind}`, asyncRoute(async (_req, res) => { res.json({ kind }); }));
  const decide = (state: string): RequestHandler => (_req, res) => { res.json({ state }); };
  router.post('/:id/accept', decide('accepted'));
  router.use('/:id/notes', notesRouter());
  return router;
}

export function hiddenRouter(): Router {
  const router = Router();
  router.get('/secret', (_req, res) => { res.json({}); });
  return router;
}
