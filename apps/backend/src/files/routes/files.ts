import { Router, type Request, type Response } from 'express';
import { asyncRoute, type ProjectMetadata } from '../../platform/index.js';
import { cleanPath } from '../lib/file-places.js';
import type { FileScope, FileService, FilesOutcome } from '../services/FileService.js';
import { isShareDays, SHARE_DAYS } from '../lib/file-shares.js';
import { servingHeaders } from '../lib/file-serving.js';

export const FILE_TYPE_HEADER = 'x-file-type';

export interface FilesRouterDeps {
  files: FileService;
  getOwnedProject: (id: string, user: { id: string; email: string; isAdmin?: boolean }) => Promise<ProjectMetadata | undefined>;
}

const userOf = (req: Request) => (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

const answer = <T>(res: Response, outcome: FilesOutcome<T>, status = 200) => (
  outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();

  const scopeOf = async (req: Request, res: Response, scope = req.params.scope): Promise<FileScope | undefined> => {
    if (scope === 'mine') return { kind: 'mine' };
    if (scope !== 'projects') { res.status(404).json({ error: 'Not found' }); return undefined; }
    const project = await deps.getOwnedProject(String(req.params.id ?? ''), userOf(req));
    if (!project) { res.status(404).json({ error: 'Project not found' }); return undefined; }
    return { kind: 'project', project };
  };

  const pathOf = (req: Request, res: Response, key: string, allowRoot = false): string | undefined => {
    const raw = typeof req.query[key] === 'string' ? String(req.query[key]) : typeof req.body?.[key] === 'string' ? String(req.body[key]) : '';
    const cleaned = cleanPath(raw, { allowRoot });
    if (!cleaned.ok) { res.status(400).json({ error: cleaned.why }); return undefined; }
    return cleaned.path;
  };

  router.get('/servers', asyncRoute(async (req, res) => {
    res.json(await deps.files.servers(userOf(req).id));
  }));

  router.put('/default', asyncRoute(async (req, res) => {
    const wanted = req.body?.deploymentId;
    if (wanted !== null && typeof wanted !== 'string') return res.status(400).json({ error: 'deploymentId must name a file server, or be null.' });
    answer(res, await deps.files.setDefault(userOf(req).id, wanted));
  }));

  router.get('/shares', asyncRoute(async (req, res) => {
    res.json(await deps.files.shares(userOf(req).id));
  }));

  router.delete('/shares/:shareId', asyncRoute(async (req, res) => {
    answer(res, await deps.files.unshare(userOf(req).id, String(req.params.shareId ?? '')));
  }));

  router.get('/projects/:id/place', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res, 'projects');
    if (!scope) return;
    res.json(await deps.files.placeOf(userOf(req).id, scope));
  }));

  router.put('/projects/:id/place', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id ?? ''), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (typeof req.body?.deploymentId !== 'string') return res.status(400).json({ error: 'deploymentId must name a file server.' });
    answer(res, await deps.files.choose(userOf(req).id, project, req.body.deploymentId));
  }));

  router.post('/projects/:id/minio', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id ?? ''), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    answer(res, await deps.files.startMinio(userOf(req).id, project), 202);
  }));

  router.get('/:scope/:id?/list', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const dir = pathOf(req, res, 'dir', true);
    if (dir === undefined) return;
    answer(res, await deps.files.list(userOf(req).id, scope, dir));
  }));

  router.get('/:scope/:id?/search', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    answer(res, await deps.files.search(userOf(req).id, scope, typeof req.query.q === 'string' ? req.query.q : ''));
  }));

  router.post('/:scope/:id?/folder', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    answer(res, await deps.files.makeFolder(userOf(req).id, scope, path), 201);
  }));

  router.post('/:scope/:id?/shares', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    if (!isShareDays(req.body?.days)) return res.status(400).json({ error: `a link lasts ${SHARE_DAYS.join(', ')} days` });
    answer(res, await deps.files.share(userOf(req).id, scope, path, req.body.days), 201);
  }));

  router.put('/:scope/:id?/content', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    const length = req.headers['content-length'];
    const type = String(req.headers[FILE_TYPE_HEADER] ?? 'application/octet-stream');
    answer(res, await deps.files.upload(userOf(req).id, scope, path, req, length ? Number(length) : undefined, type), 201);
  }));

  router.get('/:scope/:id?/content', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    const found = await deps.files.download(userOf(req).id, scope, path);
    if (!found.ok) return answer(res, found);
    res.set(servingHeaders(found.value.contentType, path.split('/').pop() ?? path, req.query.inline === '1'));
    if (found.value.size !== undefined) res.setHeader('Content-Length', String(found.value.size));
    found.value.stream.pipe(res);
  }));

  router.delete('/:scope/:id?/content', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    answer(res, await deps.files.remove(userOf(req).id, scope, path));
  }));

  router.post('/:scope/:id?/move', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const from = pathOf(req, res, 'from');
    if (from === undefined) return;
    const to = pathOf(req, res, 'to');
    if (to === undefined) return;
    answer(res, await deps.files.move(userOf(req).id, scope, from, to));
  }));

  return router;
}

export function shareRouter(deps: { files: Pick<FileService, 'shared'> }): Router {
  const router = Router();
  router.get('/:token', asyncRoute(async (req, res) => {
    const found = await deps.files.shared(String(req.params.token ?? ''));
    if (!found.ok) return res.status(found.status).type('text/plain').send(found.why);
    res.set(servingHeaders(found.value.contentType, found.value.name, req.query.download !== '1'));
    if (found.value.size !== undefined) res.setHeader('Content-Length', String(found.value.size));
    found.value.stream.pipe(res);
  }));
  return router;
}
