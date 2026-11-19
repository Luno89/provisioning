import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import { KOALA_INSTALL_FOLLOW_BEAT_MS, KOALA_INSTALL_FOLLOW_ROUTE, KOALA_INSTALL_FOLLOW_STOPPED, KOALA_INSTALL_ROUTE, koalaInstallEnded } from '@koala/engine-core/koala-install';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { InstallFollower, KoalaInstalls } from '../services/KoalaInstalls.js';
import type { InstallFollowing } from '../lib/koala-install-following.js';
import { GIT_ROUTES, type GitRoute, type MachineGitService } from '../services/MachineGitService.js';
import type { MachineMetricsRelay } from '../services/MachineMetricsRelay.js';
import { METRICS_MAX_BYTES } from '../lib/machine-metrics.js';

const bearer = (header: string | undefined): string | undefined => header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

async function bodyOf(req: Request, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const heard = (res: Response, outcome: { ok: true } | { ok: false; status: number; error: string }): Response =>
  (outcome.ok ? res.status(204).end() : res.status(outcome.status).type('text/plain').send(outcome.error));

export interface AgentBundle {
  path(): Promise<string>;
  sha256(): Promise<string>;
}

export function machinesRouter(deps: { accounts?: Pick<MachineAccounts, 'join' | 'reportJoinProgress'> | undefined; installs?: Pick<KoalaInstalls, 'report' | 'follow'> | undefined; bundle: AgentBundle; git?: Pick<MachineGitService, 'serve'> | undefined; metrics?: Pick<MachineMetricsRelay, 'write'> | undefined }): Router {
  const router = Router();

  router.post('/metrics', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.metrics) return res.status(404).type('text/plain').send('this Koala takes no metrics from machines');
    const body = await bodyOf(req, METRICS_MAX_BYTES);
    if (!body) return res.status(413).type('text/plain').send('a machine sends its metrics in batches smaller than this');
    const answer = await deps.metrics.write(bearer(req.headers.authorization), body);
    if (answer.text === undefined) return res.status(answer.status).end();
    return res.status(answer.status).type('text/plain').send(answer.text);
  }));

  router.all(/^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/, asyncRoute(async (req: Request, res: Response) => {
    if (!deps.git) return res.status(404).type('text/plain').send('this Koala serves no git to machines');
    const params = req.params as unknown as Record<string, string>;
    const route = params[1] as GitRoute;
    if (!GIT_ROUTES.includes(route)) return res.status(404).end();
    const answer = await deps.git.serve({
      token: bearer(req.headers.authorization),
      repo: decodeURIComponent(params[0] ?? ''),
      route,
      service: typeof req.query.service === 'string' ? req.query.service : undefined,
      contentType: req.headers['content-type'],
      contentEncoding: req.headers['content-encoding'],
      gitProtocol: typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : undefined,
      body: req.method === 'POST' ? req : undefined,
    });
    if ('text' in answer) {
      if (answer.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="koala"');
      return res.status(answer.status).type('text/plain').send(answer.text);
    }
    res.status(answer.status);
    for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
    answer.body.pipe(res);
  }));

  router.post('/join-progress', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.accounts) return res.status(404).type('text/plain').send('machines report their join to root, which holds accounts');
    return heard(res, await deps.accounts.reportJoinProgress(bearer(req.headers.authorization), req.body));
  }));

  router.post(KOALA_INSTALL_ROUTE, asyncRoute(async (req: Request, res: Response) => {
    if (!deps.installs) return res.status(404).type('text/plain').send('machines report putting Koala on themselves to root, which asked them');
    return heard(res, await deps.installs.report(String(req.params.installId ?? ''), bearer(req.headers.authorization), req.body));
  }));

  router.get(KOALA_INSTALL_FOLLOW_ROUTE, asyncRoute(async (req: Request, res: Response) => {
    if (!deps.installs) return res.status(404).type('text/plain').send('machines follow putting Koala on themselves at root, which asked them');
    let beat: NodeJS.Timeout | undefined;
    let stop = (): void => undefined;
    const ended = (): void => {
      clearInterval(beat);
      stop();
    };
    res.on('close', ended);
    const stream = (): void => {
      if (res.headersSent) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      beat = setInterval(() => { res.write(': beat\n\n'); }, KOALA_INSTALL_FOLLOW_BEAT_MS);
    };
    const told = (following: InstallFollowing): void => {
      if (res.writableEnded) return;
      if (following.kind === 'none' && !res.headersSent) {
        res.status(204).end();
        return;
      }
      stream();
      if (following.kind === 'waiting' || following.kind === 'none') return;
      if (following.kind === 'stopped') {
        res.end(`event: ${KOALA_INSTALL_FOLLOW_STOPPED}\ndata: ${JSON.stringify({ why: following.why })}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify(following.followed)}\n\n`);
      if (koalaInstallEnded(following.followed.install)) res.end();
    };
    const follower: InstallFollower = {
      told,
      broke: (err) => {
        console.warn(`[machines] a machine following its install of Koala was cut off: ${err.message}`);
        res.destroy(err);
      },
    };
    const outcome = await deps.installs.follow(bearer(req.headers.authorization), follower);
    if (!outcome.ok) return res.status(outcome.status).type('text/plain').send(outcome.error);
    stop = outcome.value.stop;
    if (res.writableEnded || res.destroyed) stop();
    return undefined;
  }));

  router.post('/join', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.accounts) return res.status(404).type('text/plain').send('machines join at root, which holds accounts: run the command from My Machines');
    const body = (req.body ?? {}) as { code?: unknown; hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown };
    const outcome = await deps.accounts.join(body.code, { hostname: body.hostname, rootDir: body.rootDir, os: body.os, replaces: body.replaces });
    if (!outcome.ok) return res.status(outcome.status).type('text/plain').send(outcome.error);
    res.json({ ...outcome.value, env: { ...outcome.value.env, KOALA_AGENT_SHA256: await deps.bundle.sha256() } });
  }));

  router.get('/agent.tgz', asyncRoute(async (_req: Request, res: Response) => {
    res.type('application/gzip').sendFile(await deps.bundle.path());
  }));

  router.get('/agent.tgz.sha256', asyncRoute(async (_req: Request, res: Response) => {
    res.type('text/plain').send(`${await deps.bundle.sha256()}  machine-agent.tgz\n`);
  }));

  return router;
}
