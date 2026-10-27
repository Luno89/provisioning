import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { ArtifactService } from '../services/ArtifactService.js';
import { servingHeaders } from '../lib/file-serving.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

export interface ArtifactsRouterDeps {
  artifacts: Pick<ArtifactService, 'get' | 'list'>;
  hasMinio: (ownerId: string) => Promise<boolean>;
}

export function artifactsRouter(deps: ArtifactsRouterDeps): Router {
  const router = Router();

  router.get('/storage', asyncRoute(async (req: Request, res: Response) => {
    res.json({ minio: await deps.hasMinio(userOf(req).id) });
  }));

  router.get('/runs/:runId', asyncRoute(async (req: Request, res: Response) => {
    res.json({ artifacts: await deps.artifacts.list(userOf(req).id, String(req.params.runId)) });
  }));

  router.get('/:id', asyncRoute(async (req: Request, res: Response) => {
    const found = await deps.artifacts.get(userOf(req).id, String(req.params.id));
    if (!found) return res.status(404).json({ error: 'You have no artifact with that id' });
    const filename = found.artifact.name.split('/').pop() ?? found.artifact.name;
    res.set(servingHeaders(found.artifact.contentType, filename, true));
    res.setHeader('Content-Length', String(found.bytes.length));
    return res.end(found.bytes);
  }));

  return router;
}
