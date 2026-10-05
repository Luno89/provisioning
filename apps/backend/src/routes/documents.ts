import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { DocumentService } from '../services/DocumentService.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

export function documentsRouter(deps: { documents: DocumentService }): Router {
  const router = Router();

  router.get('/:workspace', asyncRoute(async (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const at = typeof req.query.at === 'string' && req.query.at ? req.query.at : undefined;
    const read = await deps.documents.read(userOf(req).id, String(req.params.workspace ?? ''), path, at);
    if (!read.ok) return res.status(read.status).json({ error: read.error });
    res.json(read.document);
  }));

  return router;
}
