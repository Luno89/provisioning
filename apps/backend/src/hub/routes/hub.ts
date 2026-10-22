import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { HubOutcome, HubService } from '../services/HubService.js';
import type { RelayAnswer } from '../services/HubRelay.js';
import type { RelayOp } from '../lib/hub-board.js';
import { cleanPath } from '../../files/lib/file-places.js';
import { servingHeaders } from '../../files/lib/file-serving.js';
import { FILE_TYPE_HEADER } from '../../files/routes/files.js';

const personOf = (req: Request) => {
  const user = (req as unknown as { user: { id: string; email: string } }).user;
  return { id: user.id, email: user.email };
};

const answer = <T>(res: Response, outcome: HubOutcome<T>, status = 200) => (
  outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

const query = (req: Request, name: string): string | undefined => (typeof req.query[name] === 'string' ? String(req.query[name]) : undefined);

export function sendRelayed(res: Response, answer: RelayAnswer, inline: boolean, fallbackName: string): void {
  if (answer.kind === 'json') {
    res.status(answer.status).json(answer.body);
    return;
  }
  res.status(answer.status);
  res.set(servingHeaders(answer.type, answer.name ?? fallbackName, inline));
  if (answer.size !== undefined) res.setHeader('Content-Length', String(answer.size));
  answer.stream.on('error', () => res.destroy());
  answer.stream.pipe(res);
}

export function hubRouter(deps: { hub: HubService }): Router {
  const router = Router();

  router.get('/projects', asyncRoute(async (req, res) => {
    res.json(await deps.hub.mine(personOf(req).id));
  }));

  router.get('/projects/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.view(personOf(req).id, param(req, 'id')));
  }));

  router.delete('/projects/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.delete(personOf(req).id, param(req, 'id'), req.body?.name));
  }));

  router.post('/projects/:id/invites', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.invite(personOf(req), param(req, 'id'), { email: req.body?.email, role: req.body?.role }), 201);
  }));

  router.delete('/projects/:id/invites', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.takeBack(personOf(req).id, param(req, 'id'), typeof req.query.email === 'string' ? req.query.email : ''));
  }));

  router.put('/projects/:id/members/:personId', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.changeRole(personOf(req).id, param(req, 'id'), param(req, 'personId'), req.body?.role));
  }));

  router.delete('/projects/:id/members/:personId', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.remove(personOf(req).id, param(req, 'id'), param(req, 'personId')));
  }));

  router.get('/projects/:id/board', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.boardView(personOf(req).id, param(req, 'id')));
  }));

  router.get('/projects/:id/conversations/:conversationId', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.conversation(personOf(req).id, param(req, 'id'), param(req, 'conversationId')));
  }));

  router.post('/projects/:id/conversations/:conversationId/messages', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.post(personOf(req), param(req, 'id'), param(req, 'conversationId'), { content: req.body?.content, askKoala: req.body?.askKoala }), 201);
  }));

  router.post('/projects/:id/requests', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.request(personOf(req), param(req, 'id'), (req.body ?? {}) as Record<string, unknown>), 202);
  }));

  const relayed = (req: Request, res: Response, op: RelayOp, args: Record<string, unknown>, upload?: Parameters<HubService['relay']>[4]) => (async () => {
    const outcome = await deps.hub.relay(personOf(req), param(req, 'id'), op, args, upload);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.why });
    sendRelayed(res, outcome.value, req.query.inline === '1', String(args.path ?? 'file').split('/').pop() ?? 'file');
  })();

  router.get('/projects/:id/live/turns/:turnId', asyncRoute(async (req, res) => relayed(req, res, 'turns', { turnId: param(req, 'turnId'), after: Number(query(req, 'after') ?? 0), ...(query(req, 'under') ? { under: query(req, 'under') } : {}) })));
  router.get('/projects/:id/live/procedures/:procedureId', asyncRoute(async (req, res) => relayed(req, res, 'procedure', { id: param(req, 'procedureId') })));
  router.get('/projects/:id/live/extensions', asyncRoute(async (req, res) => relayed(req, res, 'extensions', {})));

  const pathIn = (req: Request, res: Response, key: string, allowRoot = false): string | undefined => {
    const raw = query(req, key) ?? (typeof req.body?.[key] === 'string' ? String(req.body[key]) : '');
    const cleaned = cleanPath(raw, { allowRoot });
    if (!cleaned.ok) { res.status(400).json({ error: cleaned.why }); return undefined; }
    return cleaned.path;
  };

  router.get('/projects/:id/repository', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.repository(personOf(req).id, param(req, 'id')));
  }));
  router.get('/projects/:id/repository/file', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path');
    if (path !== undefined) answer(res, await deps.hub.repositoryFile(personOf(req).id, param(req, 'id'), path));
  }));

  router.get('/projects/:id/files/list', asyncRoute(async (req, res) => {
    const dir = pathIn(req, res, 'dir', true);
    if (dir !== undefined) await relayed(req, res, 'files.list', { dir });
  }));
  router.get('/projects/:id/files/search', asyncRoute(async (req, res) => relayed(req, res, 'files.search', { q: query(req, 'q') ?? '' })));
  router.post('/projects/:id/files/folder', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path');
    if (path !== undefined) await relayed(req, res, 'files.folder', { path });
  }));
  router.get('/projects/:id/files/content', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path');
    if (path !== undefined) await relayed(req, res, 'files.read', { path });
  }));
  router.put('/projects/:id/files/content', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path');
    if (path === undefined) return;
    const length = req.headers['content-length'];
    const type = String(req.headers[FILE_TYPE_HEADER] ?? 'application/octet-stream');
    await relayed(req, res, 'files.upload', { path, type, ...(length ? { size: Number(length) } : {}) }, { stream: req, type, ...(length ? { size: Number(length) } : {}) });
  }));
  router.delete('/projects/:id/files/content', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path');
    if (path !== undefined) await relayed(req, res, 'files.remove', { path });
  }));
  router.post('/projects/:id/files/move', asyncRoute(async (req, res) => {
    const from = pathIn(req, res, 'from');
    if (from === undefined) return;
    const to = pathIn(req, res, 'to');
    if (to !== undefined) await relayed(req, res, 'files.move', { from, to });
  }));
  router.put('/projects/:id/files/for-clients', asyncRoute(async (req, res) => {
    const path = pathIn(req, res, 'path', true);
    if (path !== undefined) await relayed(req, res, 'files.for-clients', { path, on: req.body?.on === true });
  }));

  router.get('/invitations/:token', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.invitation(personOf(req), param(req, 'token')));
  }));

  router.post('/invitations/:token/accept', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.accept(personOf(req), param(req, 'token')));
  }));

  return router;
}
