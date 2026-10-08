import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ArtifactService } from '../services/ArtifactService.js';

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
    res.setHeader('Content-Type', found.artifact.contentType);
    res.setHeader('Content-Length', String(found.bytes.length));
    res.setHeader('Content-Disposition', `${found.artifact.contentType.startsWith('image/') || found.artifact.contentType.startsWith('video/') ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(found.bytes);
  }));

  return router;
}
