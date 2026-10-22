import type crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { checkMoveToken } from '../../instances/lib/identity-token.js';
import type { HubOutcome, HubService, SyncOrigin } from '../services/HubService.js';

const header = (req: Request, name: string): string => String(req.headers[name] ?? '');

const answer = <T>(res: Response, outcome: HubOutcome<T>) => (
  outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

export type InstanceHub = Pick<HubService, 'share' | 'unshare' | 'receive' | 'changesSince' | 'waitingRequests' | 'settleRequest' | 'putStatus' | 'takeRelay' | 'relayed' | 'answerRelay'>;

import { RELAY_NAME_HEADER, RELAY_STATUS_HEADER, RELAY_TYPE_HEADER } from '../lib/hub-board.js';

export function hubInstanceRouter(deps: { hub: InstanceHub; trusted: ReadonlyMap<string, crypto.KeyObject> }): Router {
  const router = Router();
  const originOf = (req: Request): SyncOrigin | undefined => {
    const instanceId = header(req, 'x-koala-instance');
    const personId = header(req, 'x-koala-person');
    const email = header(req, 'x-koala-email');
    const token = header(req, 'authorization').replace(/^Bearer\s+/i, '');
    if (!instanceId || !personId || !email) return undefined;
    return checkMoveToken(token, deps.trusted, HUB_AUDIENCE, hubInstancePart(instanceId, personId, email)).ok ? { kind: 'instance', instanceId, personId, email } : undefined;
  };
  const withOrigin = (work: (origin: SyncOrigin, req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    const origin = originOf(req);
    if (!origin) return res.status(401).json({ error: 'only an instance root vouches for reaches this' });
    await work(origin, req, res);
  });

  router.post('/share', withOrigin(async (origin, req, res) => answer(res, await deps.hub.share(origin, { name: req.body?.name, projectId: req.body?.projectId, group: req.body?.group }))));
  router.delete('/projects/:id', withOrigin(async (origin, req, res) => answer(res, await deps.hub.unshare(origin, String(req.params.id)))));
  router.post('/projects/:id/changes', withOrigin(async (origin, req, res) => answer(res, await deps.hub.receive(origin, String(req.params.id), req.body?.changes))));
  router.get('/projects/:id/changes', withOrigin(async (origin, req, res) => answer(res, await deps.hub.changesSince(origin, String(req.params.id), Number(req.query.after ?? 0)))));
  router.get('/projects/:id/requests', withOrigin(async (origin, req, res) => answer(res, await deps.hub.waitingRequests(origin, String(req.params.id)))));
  router.post('/projects/:id/requests/:requestId', withOrigin(async (origin, req, res) => answer(res, await deps.hub.settleRequest(origin, String(req.params.id), String(req.params.requestId), { state: req.body?.state, why: req.body?.why }))));
  router.put('/projects/:id/status', withOrigin(async (origin, req, res) => answer(res, await deps.hub.putStatus(origin, String(req.params.id), req.body?.status))));

  router.get('/projects/:id/relay', withOrigin(async (origin, req, res) => {
    const closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
    const taken = await deps.hub.takeRelay(origin, String(req.params.id), closed);
    if (!taken.ok) return res.status(taken.status).json({ error: taken.why });
    if (!taken.value) return res.status(204).end();
    const { upload, ...call } = taken.value;
    if (res.writableEnded || res.destroyed) return;
    res.json({ ...call, ...(upload ? { upload: { type: upload.type, ...(upload.size !== undefined ? { size: upload.size } : {}) } } : {}) });
  }));

  router.get('/relay/:callId/upload', withOrigin(async (origin, req, res) => {
    const call = await deps.hub.relayed(origin, String(req.params.callId));
    if (!call.ok) return res.status(call.status).json({ error: call.why });
    if (!call.value.upload) return res.status(404).json({ error: 'That call carries nothing to upload.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    if (call.value.upload.size !== undefined) res.setHeader('Content-Length', String(call.value.upload.size));
    call.value.upload.stream.pipe(res);
  }));

  router.post('/relay/:callId', withOrigin(async (origin, req, res) => {
    const status = Number(req.body?.status);
    answer(res, await deps.hub.answerRelay(origin, String(req.params.callId), { kind: 'json', status: Number.isInteger(status) ? status : 502, body: req.body?.body ?? null }));
  }));

  router.post('/relay/:callId/stream', withOrigin(async (origin, req, res) => {
    const length = req.headers['content-length'];
    const status = Number(header(req, RELAY_STATUS_HEADER));
    const done = new Promise<void>((resolve) => { req.on('end', () => resolve()); req.on('close', () => resolve()); });
    const outcome = await deps.hub.answerRelay(origin, String(req.params.callId), {
      kind: 'stream',
      status: Number.isInteger(status) && status > 0 ? status : 200,
      type: header(req, RELAY_TYPE_HEADER) || 'application/octet-stream',
      ...(header(req, RELAY_NAME_HEADER) ? { name: decodeURIComponent(header(req, RELAY_NAME_HEADER)) } : {}),
      ...(length ? { size: Number(length) } : {}),
      stream: req,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.why });
    await done;
    res.json(outcome.value);
  }));

  return router;
}
