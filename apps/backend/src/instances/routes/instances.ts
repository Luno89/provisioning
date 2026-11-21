import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { mailProblem, MailError, type MailReputation, type MailService, asyncRoute, type OpenRoute } from '../../platform/index.js';
import type { InstanceService, StatusReport } from '../services/InstanceService.js';
import type { DependencyWatch } from '../services/DependencyWatch.js';
import type { InstanceMailLimit } from '../services/InstanceMailLimit.js';
import { heldBackMail } from '../lib/instance-mail-limit.js';
import { isDeletionProgress, type DeletionProgress } from '../../projects/index.js';

export interface OwnerRemovalAtRoot {
  removing(ownerId: string): Promise<boolean>;
  told(ownerId: string, progress: DeletionProgress): Promise<{ ok: true; value: Record<string, never> } | { ok: false; status: number; error: string }>;
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const credentialOf = (req: Request): { instanceId: string; credential: string } => ({
  instanceId: String(req.headers['x-instance-id'] ?? ''),
  credential: String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
});

const answer = <T,>(res: Response, outcome: { ok: true; value: T } | { ok: false; status: number; error: string }) =>
  (outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.error }));

const notifyOf = (req: Request): unknown => ((req.body ?? {}) as { notifyWhenUnreachable?: unknown }).notifyWhenUnreachable;

export const INSTANCES_OPEN: readonly OpenRoute[] = ['/chart.tgz', '/chart/:file', '/release', '/status', '/addresses', '/updates', '/release-findings', '/groups', '/groups/check', '/groups/:projectId', '/watch', '/mail', '/owner-removal'];

export function instancesRouter(deps: {
  instances: Pick<InstanceService, 'release' | 'updates' | 'setUpdates' | 'report' | 'mine' | 'nameCheck' | 'addresses' | 'setAddresses' | 'checkGroup' | 'claimGroup' | 'releaseGroup' | 'ownerOf' | 'runningOf' | 'watchAs' | 'setWatchAs' | 'setWatchOf'>;
  chart: () => Promise<string>;
  mailLimit?: InstanceMailLimit | undefined;
  chartOf?: ((imageTag: string) => string | undefined) | undefined;
  mail?: Pick<MailService, 'toOwner'> | undefined;
  operatorOnly?: RequestHandler | undefined;
  administers?: RequestHandler | undefined;
  dependencies?: Pick<DependencyWatch, 'view' | 'check' | 'forRelease'> | undefined;
  mailReputation?: Pick<MailReputation, 'view' | 'check'> | undefined;
  ownerRemoval?: OwnerRemovalAtRoot | undefined;
}): Router {
  const router = Router();

  router.get('/name-check', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.instances.nameCheck(userOf(req).id, req.query.name));
  }));

  const admin: RequestHandler = deps.operatorOnly ?? ((_req: Request, res: Response, _next: NextFunction) => { res.status(403).json({ error: 'Admin only' }); });

  router.get('/mine', asyncRoute(async (req: Request, res: Response) => {
    res.json({ instance: await deps.instances.mine(userOf(req).id) });
  }));

  router.put('/mine/watch', asyncRoute(async (req: Request, res: Response) => {
    return answer(res, await deps.instances.setWatchOf(userOf(req).id, notifyOf(req)));
  }));

  router.get('/watch', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.watchAs(instanceId, credential));
  }));

  router.put('/watch', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.setWatchAs(instanceId, credential, notifyOf(req)));
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
    return answer(res, await deps.instances.updates(instanceId, credential));
  }));

  const administers: RequestHandler = deps.administers ?? admin;

  router.get('/dependencies', administers, asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.dependencies) return res.status(404).json({ error: 'this server keeps no record of its dependencies' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await deps.dependencies.view());
  }));

  router.post('/dependencies/check', administers, asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.dependencies) return res.status(404).json({ error: 'this server keeps no record of its dependencies' });
    try {
      return res.json(await deps.dependencies.check());
    } catch (err) {
      return res.status(502).json({ error: `the check could not finish: ${(err as Error).message}` });
    }
  }));

  router.get('/mail-reputation', administers, (_req: Request, res: Response) => {
    if (!deps.mailReputation) return res.status(404).json({ error: 'this server does not send mail itself' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(deps.mailReputation.view());
  });

  router.post('/mail-reputation/check', administers, (_req: Request, res: Response) => {
    if (!deps.mailReputation) return res.status(404).json({ error: 'this server does not send mail itself' });
    void deps.mailReputation.check().catch((err: Error) => console.warn(`[mail] the check of root's mail could not finish: ${err.message}`));
    return res.status(202).json(deps.mailReputation.view());
  });

  router.get('/release-findings', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const outcome = await deps.instances.runningOf(instanceId, credential);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    if (!deps.dependencies || !outcome.value.running) return res.json({ findings: [] });
    return res.json(await deps.dependencies.forRelease(outcome.value.running));
  }));

  router.put('/updates', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.setUpdates(instanceId, credential, (req.body ?? {}) as { auto?: unknown; version?: unknown }));
  }));

  router.get('/release', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.release(instanceId, credential));
  }));


  router.get('/addresses', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.addresses(instanceId, credential));
  }));

  router.put('/addresses', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    return answer(res, await deps.instances.setAddresses(instanceId, credential, ((req.body ?? {}) as { nested?: unknown }).nested));
  }));

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

  router.post('/mail', asyncRoute(async (req: Request, res: Response) => {
    const { instanceId, credential } = credentialOf(req);
    const owner = await deps.instances.ownerOf(instanceId, credential);
    if (!owner.ok) return res.status(owner.status).json({ error: owner.error });
    const body = (req.body ?? {}) as { subject?: unknown; text?: unknown };
    const problem = mailProblem(body);
    if (problem) return res.status(400).json({ error: problem });
    if (!deps.mail) return res.status(503).json({ error: 'this root sends no email' });
    const verdict = deps.mailLimit?.take(instanceId);
    if (verdict && !verdict.send) {
      if (verdict.tell) await deps.mail.toOwner(owner.value.ownerId, heldBackMail(verdict.until)).catch((err: Error) => console.warn(`[mail] ${instanceId}'s owner could not be told their email is held back: ${err.message}`));
      return res.status(429).json({ error: `this instance has sent as many emails as an hour allows; more are held back until ${new Date(verdict.until).toISOString()}` });
    }
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
    const outcome = await deps.instances.report(instanceId, credential, (req.body ?? {}) as StatusReport);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ status: outcome.value.status });
  }));

  const ownerOfCaller = async (req: Request, res: Response): Promise<string | undefined> => {
    if (!deps.ownerRemoval) {
      res.status(404).json({ error: 'this server removes no accounts' });
      return undefined;
    }
    const { instanceId, credential } = credentialOf(req);
    const owner = await deps.instances.ownerOf(instanceId, credential);
    if (!owner.ok) {
      res.status(owner.status).json({ error: owner.error });
      return undefined;
    }
    return owner.value.ownerId;
  };

  router.get('/owner-removal', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await ownerOfCaller(req, res);
    if (ownerId === undefined) return undefined;
    return res.json({ removing: await deps.ownerRemoval!.removing(ownerId) });
  }));

  router.put('/owner-removal', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = await ownerOfCaller(req, res);
    if (ownerId === undefined) return undefined;
    const progress = ((req.body ?? {}) as { progress?: unknown }).progress;
    if (!isDeletionProgress(progress)) return res.status(400).json({ error: 'send progress: how the removal stands, its seq, phase, work and parts' });
    return answer(res, await deps.ownerRemoval!.told(ownerId, progress));
  }));

  return router;
}
