import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { InstanceService, JoinBundle } from '../services/InstanceService.js';

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
  ];
  return `${lines.map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n')}\n`;
}

export function instancesRouter(deps: {
  instances: Pick<InstanceService, 'createJoinToken' | 'join' | 'release' | 'report' | 'mine'>;
  chart: () => Promise<string>;
}): Router {
  const router = Router();

  router.post('/join-tokens', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.instances.createJoinToken(userOf(req).id));
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

  router.get('/release', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.release(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.post('/status', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.report(instanceId, credential, (req.body ?? {}) as { status?: unknown; detail?: unknown; url?: unknown });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ status: outcome.value.status });
  }));

  return router;
}
