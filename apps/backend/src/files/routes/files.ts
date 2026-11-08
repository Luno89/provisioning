import { Router, type Request, type Response } from 'express';
import { asyncRoute, at, type Principal, principalFrom, type ProjectMetadata } from '../../platform/index.js';
import { DROP_TYPE } from '../lib/drops.js';
import { cleanPath } from '../lib/file-places.js';
import type { FileScope, FileService, FilesOutcome } from '../services/FileService.js';
import { isShareDays, SHARE_DAYS } from '../lib/file-shares.js';
import { servingHeaders } from '../lib/file-serving.js';

export const FILE_TYPE_HEADER = 'x-file-type';

export interface FilesRouterDeps {
  files: FileService;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>;
  getOwnedConversation: (ownerId: string, id: string) => Promise<{ id: string; projectId?: string | undefined } | undefined>;
}

const userOf = (req: Request) => (req as unknown as { user: { id: string; email: string } }).user;

const answer = <T>(res: Response, outcome: FilesOutcome<T>, status = 200) => {
  if (outcome.ok) return res.status(status).json(outcome.value);
  const { ok: _ok, status: refusedWith, why, ...details } = outcome;
  return res.status(refusedWith).json({ error: why, ...details });
};

const lengthOf = (req: Request): number | undefined => {
  const length = req.headers['content-length'];
  return length ? Number(length) : undefined;
};

export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();

  const scopeOf = async (req: Request, res: Response, scope = req.params.scope): Promise<FileScope | undefined> => {
    if (scope === 'mine') return { kind: 'person' };
    if (scope === 'conversations') {
      const conversation = await deps.getOwnedConversation(userOf(req).id, String(req.params.id ?? ''));
      if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return undefined; }
      return { kind: 'conversation', conversationId: conversation.id, ...(conversation.projectId ? { projectId: conversation.projectId } : {}) };
    }
    if (scope !== 'projects') { res.status(404).json({ error: 'Not found' }); return undefined; }
    const project = await deps.getOwnedProject(String(req.params.id ?? ''), principalFrom(req));
    if (!project) { res.status(404).json({ error: 'Project not found' }); return undefined; }
    return { kind: 'project', project };
  };

  const pathOf = (req: Request, res: Response, key: string, allowRoot = false): string | undefined => {
    const query = req.query[key];
    const body = at(req.body, key);
    const raw = typeof query === 'string' ? query : typeof body === 'string' ? body : '';
    const cleaned = cleanPath(raw, { allowRoot });
    if (!cleaned.ok) { res.status(400).json({ error: cleaned.why }); return undefined; }
    return cleaned.path;
  };

  router.get('/room', asyncRoute(async (_req, res) => {
    res.json(await deps.files.room());
  }));

  router.get('/shares', asyncRoute(async (req, res) => {
    res.json(await deps.files.shares(userOf(req).id));
  }));

  router.delete('/shares/:shareId', asyncRoute(async (req, res) => {
    answer(res, await deps.files.unshare(userOf(req).id, String(req.params.shareId ?? '')));
  }));

  router.get('/stored/:fileId', asyncRoute(async (req, res) => {
    const found = await deps.files.downloadById(userOf(req).id, String(req.params.fileId ?? ''));
    if (!found.ok) return answer(res, found);
    res.set(servingHeaders(found.value.contentType, found.value.name, req.query.inline === '1'));
    if (found.value.size !== undefined) res.setHeader('Content-Length', String(found.value.size));
    found.value.stream.pipe(res);
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
    const days = at(req.body, 'days');
    if (!isShareDays(days)) return res.status(400).json({ error: `a link lasts ${SHARE_DAYS.join(', ')} days` });
    answer(res, await deps.files.share(userOf(req).id, scope, path, days), 201);
  }));

  router.put('/:scope/:id?/content', asyncRoute(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (!scope) return;
    const path = pathOf(req, res, 'path');
    if (path === undefined) return;
    const type = String(req.headers[FILE_TYPE_HEADER] ?? 'application/octet-stream');
    answer(res, await deps.files.upload(userOf(req).id, scope, path, req, lengthOf(req), type, { replace: req.query.replace === '1' }), 201);
  }));

  router.post('/:scope/:id?/drop', asyncRoute(async (req, res) => {
    if (!req.is(DROP_TYPE)) return res.status(415).json({ error: `Send a drop as ${DROP_TYPE}.` });
    const scope = await scopeOf(req, res);
    if (!scope) return;
    answer(res, await deps.files.drop(userOf(req).id, scope, req, lengthOf(req)), 201);
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
