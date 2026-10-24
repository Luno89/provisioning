import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { pipeline } from 'stream';
import { mailProblem, MailError, type MailService, asyncRoute } from '../../platform/index.js';
import type { InstanceService, JoinBundle } from '../services/InstanceService.js';
import { PoolMonitoringError, type PoolMonitoringService } from '../services/PoolMonitoringService.js';
import { parseAsk, parseRange, parsePoolRule, parseProbes } from '../../monitoring/index.js';
import { isMovePart } from '../lib/instance-move.js';
import { volumeOfPart } from '../lib/app-move.js';
import type { MoveRelay } from '../services/MoveRelay.js';
import type { HubAccess } from '../../hub/index.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const credentialOf = (req: Request): { instanceId: string; credential: string } => ({
  instanceId: String(req.headers['x-instance-id'] ?? ''),
  credential: String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
});

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function bundleAsEnv(bundle: JoinBundle): string {
  const lines: Array<[string, string]> = [
    ['INSTANCE_ID', bundle.instanceId],
    ['INSTANCE_OWNER_ID', bundle.ownerId],
    ['ROOT_URL', bundle.rootUrl],
    ['ROOT_PUBLIC_KEYS_B64', Buffer.from(bundle.rootPublicKeys).toString('base64')],
    ['MESH_LOGIN_SERVER', bundle.meshLoginServer],
    ['MESH_PREAUTH_KEY', bundle.preAuthKey],
    ['INSTANCE_REGISTRY', bundle.registry],
    ['INSTANCE_IMAGE', bundle.image],
    ['INSTANCE_IMAGE_TAG', bundle.imageTag],
    ['INSTANCE_CHART_URL', bundle.chartUrl],
    ['INSTANCE_CREDENTIAL', bundle.credential],
    ['INSTANCE_NAME', bundle.name],
    ['INSTANCE_DOMAIN', bundle.domain],
    ['INSTANCE_MOVE', bundle.move ? 'yes' : ''],
  ];
  return `${lines.map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n')}\n`;
}

export function instancesRouter(deps: {
  instances: Pick<InstanceService, 'createJoinToken' | 'poolOffer' | 'createPoolInstance' | 'poolAdmin' | 'setTrialDays' | 'setTrialEnd' | 'removePoolInstance' | 'join' | 'release' | 'updates' | 'setUpdates' | 'report' | 'mine' | 'machineKey' | 'nameCheck' | 'addresses' | 'setAddresses' | 'checkGroup' | 'claimGroup' | 'releaseGroup' | 'ownerOf' | 'trialOf' | 'poolPlaceOf' | 'startMove' | 'startMoveAs' | 'moveOf' | 'moveOfAs' | 'stopMove' | 'stopMoveAs' | 'moveSource'>;
  chart: () => Promise<string>;
  chartOf?: ((imageTag: string) => string | undefined) | undefined;
  mail?: Pick<MailService, 'toOwner'> | undefined;
  poolMonitoring?: PoolMonitoringService | undefined;
  moveRelay?: MoveRelay | undefined;
  requireAdmin?: RequestHandler | undefined;
  hubAccess?: ((instanceId: string, ownerId: string) => Promise<HubAccess | undefined>) | undefined;
}): Router {
  const router = Router();

  router.get('/name-check', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.instances.nameCheck(userOf(req).id, req.query.name));
  }));

  router.post('/join-tokens', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.instances.createJoinToken(userOf(req).id, ((req.body ?? {}) as { name?: unknown }).name);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.get('/pool', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.instances.poolOffer(userOf(req).id));
  }));

  router.post('/pool', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.instances.createPoolInstance(userOf(req).id, ((req.body ?? {}) as { name?: unknown }).name);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(202).json(outcome.value);
  }));

  const admin: RequestHandler = deps.requireAdmin ?? ((_req: Request, res: Response, _next: NextFunction) => { res.status(403).json({ error: 'Admin only' }); });

  router.get('/pool/admin', admin, asyncRoute(async (_req: Request, res: Response) => {
    const outcome = await deps.instances.poolAdmin();
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/pool/admin/trial-days', admin, asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.instances.setTrialDays(userOf(req).id, ((req.body ?? {}) as { days?: unknown }).days);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/pool/admin/instances/:id/trial', admin, asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.instances.setTrialEnd(String(req.params.id), ((req.body ?? {}) as { trialEndsAt?: unknown }).trialEndsAt);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.delete('/pool/admin/instances/:id', admin, asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.instances.removePoolInstance(String(req.params.id), ((req.body ?? {}) as { confirm?: unknown }).confirm);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(202).json(outcome.value);
  }));

  router.get('/mine', asyncRoute(async (req: Request, res: Response) => {
    res.json({ instance: await deps.instances.mine(userOf(req).id) });
  }));

  router.post('/join', asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { token?: unknown; machine?: unknown };
    const outcome = await deps.instances.join(body.token, body.machine);
    res.setHeader('Cache-Control', 'no-store');
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    if (req.query.format === 'env') return res.type('text/plain').send(bundleAsEnv(outcome.value));
    return res.json(outcome.value);
  }));

  router.get('/chart.tgz', asyncRoute(async (_req: Request, res: Response) => {
    res.type('application/gzip').sendFile(await deps.chart());
  }));

  router.get('/chart/:file', asyncRoute(async (req: Request, res: Response) => {
    const imageTag = /^(.+)\.tgz$/.exec(String(req.params.file ?? ''))?.[1];
    const file = imageTag ? deps.chartOf?.(imageTag) : undefined;
    if (!file) return res.status(404).json({ error: 'root keeps no chart for that release' });
    return res.type('application/gzip').sendFile(file);
  }));

  router.get('/updates', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.updates(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/updates', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.setUpdates(instanceId, credential, (req.body ?? {}) as { auto?: unknown; version?: unknown });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.get('/release', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.release(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.post('/machine-key', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.machineKey(instanceId, credential);
    res.setHeader('Cache-Control', 'no-store');
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.get('/trial', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.trialOf(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.get('/addresses', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.addresses(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/addresses', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.setAddresses(instanceId, credential, ((req.body ?? {}) as { nested?: unknown }).nested);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  const answer = <T,>(res: Response, outcome: { ok: true; value: T } | { ok: false; status: number; error: string }) =>
    (outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.error }));

  router.get('/groups/check', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    answer(res, await deps.instances.checkGroup(instanceId, credential, req.query.name));
  }));

  router.put('/groups', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const body = (req.body ?? {}) as { projectId?: unknown; name?: unknown };
    answer(res, await deps.instances.claimGroup(instanceId, credential, body.projectId, body.name));
  }));

  router.delete('/groups/:projectId', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    answer(res, await deps.instances.releaseGroup(instanceId, credential, String(req.params.projectId ?? '')));
  }));

  router.post('/move', asyncRoute(async (req: Request, res: Response) => answer(res, await deps.instances.startMove(userOf(req).id))));
  router.get('/move', asyncRoute(async (req: Request, res: Response) => res.json({ move: await deps.instances.moveOf(userOf(req).id) })));
  router.delete('/move', asyncRoute(async (req: Request, res: Response) => answer(res, await deps.instances.stopMove(userOf(req).id))));

  router.post('/move/self', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.startMoveAs(instanceId, credential));
  }));
  router.get('/move/self', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.moveOfAs(instanceId, credential);
    return outcome.ok ? res.json({ move: outcome.value }) : res.status(outcome.status).json({ error: outcome.error });
  }));
  router.delete('/move/self', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.stopMoveAs(instanceId, credential));
  }));

  router.get('/move/parts/:part', asyncRoute(async (req: Request, res: Response) => {
    const part = String(req.params.part ?? '');
    if (!isMovePart(part) && !volumeOfPart(part)) return res.status(404).json({ error: 'that is not a part of an instance' });
    const { instanceId, credential } = credentialOf(req);
    const source = await deps.instances.moveSource(instanceId, credential);
    if (!source.ok) return res.status(source.status).json({ error: source.error });
    if (!deps.moveRelay) return res.status(503).json({ error: 'this root moves no instances' });
    const upstream = await deps.moveRelay.open(source.value, part).catch((err: Error) => err);
    if (upstream instanceof Error) return res.status(502).json({ error: `Koala's servers could not be reached: ${upstream.message}` });
    res.status(upstream.statusCode ?? 502);
    const type = upstream.headers['content-type'];
    if (type) res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    pipeline(upstream, res, () => undefined);
    req.on('close', () => upstream.destroy());
    return undefined;
  }));

  const poolPlace = async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const place = await deps.instances.poolPlaceOf(instanceId, credential);
    if (!place.ok) {
      res.status(place.status).json({ error: place.error });
      return undefined;
    }
    if (!deps.poolMonitoring) {
      res.status(503).json({ error: 'this root watches no pool' });
      return undefined;
    }
    return { ...place.value, monitoring: deps.poolMonitoring };
  };

  const answered = (res: Response, err: unknown) => {
    if (err instanceof PoolMonitoringError) return res.status(err.status).json({ error: err.message });
    return res.status(502).json({ error: `Koala's servers could not answer: ${(err as Error).message.split('\n')[0]}` });
  };

  router.get('/monitoring', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    return res.json(place.monitoring.history());
  }));

  router.post('/monitoring/ask', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    const body = (req.body ?? {}) as { ask?: unknown; range?: unknown };
    const ask = parseAsk(body.ask);
    if (!ask) return res.status(400).json({ error: 'that is not a question Koala answers' });
    const range = body.range === undefined ? undefined : parseRange(body.range);
    if (body.range !== undefined && !range) return res.status(400).json({ error: 'that is not a time range Koala answers for' });
    try {
      if (range) return res.json({ points: await place.monitoring.askRange(place, ask, range) });
      return res.json({ samples: await place.monitoring.ask(place, ask) });
    } catch (err) {
      return answered(res, err);
    }
  }));

  router.get('/monitoring/alerts', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    try {
      return res.json({ alerts: await place.monitoring.alerts(place) });
    } catch (err) {
      return answered(res, err);
    }
  }));

  router.put('/monitoring/probes', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    const probes = parseProbes(((req.body ?? {}) as { probes?: unknown }).probes);
    if (!probes) return res.status(400).json({ error: 'probes are a list of an app\'s namespace, service, port, path and module' });
    try {
      return res.json(await place.monitoring.setProbes(place.name, place, probes));
    } catch (err) {
      return answered(res, err);
    }
  }));

  router.put('/monitoring/rules/:id', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    const rule = parsePoolRule(String(req.params.id ?? ''), req.body);
    if ('error' in rule) return res.status(400).json({ error: rule.error });
    try {
      await place.monitoring.setRule(place, rule);
      return res.json({ set: rule.id });
    } catch (err) {
      return answered(res, err);
    }
  }));

  router.delete('/monitoring/rules/:id', asyncRoute(async (req: Request, res: Response) => {
    const place = await poolPlace(req, res);
    if (!place) return undefined;
    try {
      await place.monitoring.removeRule(place, String(req.params.id ?? ''));
      return res.json({ removed: true });
    } catch (err) {
      return answered(res, err);
    }
  }));

  router.post('/hub-token', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const owner = await deps.instances.ownerOf(instanceId, credential);
    if (!owner.ok) return res.status(owner.status).json({ error: owner.error });
    const access = deps.hubAccess ? await deps.hubAccess(instanceId, owner.value.ownerId) : undefined;
    if (!access) return res.status(404).json({ error: 'this root has no hub' });
    res.json(access);
  }));

  router.post('/mail', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const owner = await deps.instances.ownerOf(instanceId, credential);
    if (!owner.ok) return res.status(owner.status).json({ error: owner.error });
    const body = (req.body ?? {}) as { subject?: unknown; text?: unknown };
    const problem = mailProblem(body);
    if (problem) return res.status(400).json({ error: problem });
    if (!deps.mail) return res.status(503).json({ error: 'this root sends no email' });
    try {
      await deps.mail.toOwner(owner.value.ownerId, { subject: body.subject as string, text: body.text as string });
      return res.json({ sent: true });
    } catch (err) {
      if (err instanceof MailError) return res.status(err.status).json({ error: err.message });
      return res.status(502).json({ error: `it could not be sent: ${(err as Error).message}` });
    }
  }));

  router.post('/status', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.report(instanceId, credential, (req.body ?? {}) as { status?: unknown; detail?: unknown; url?: unknown; meshIp?: unknown; moved?: unknown; imageTag?: unknown });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ status: outcome.value.status });
  }));

  return router;
}
