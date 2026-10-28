import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { MachineService } from '../services/MachineService.js';
import { GIT_ROUTES, type GitRoute, type MachineGitService } from '../services/MachineGitService.js';

const bearer = (header: string | undefined): string | undefined => header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

export interface AgentBundle {
  path(): Promise<string>;
  sha256(): Promise<string>;
}

export function machinesRouter(deps: { machines: Pick<MachineService, 'join'>; bundle: AgentBundle; git?: Pick<MachineGitService, 'serve'> | undefined }): Router {
  const router = Router();

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

  router.post('/join', asyncRoute(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { code?: unknown; hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown };
    const outcome = await deps.machines.join(body.code, { hostname: body.hostname, rootDir: body.rootDir, os: body.os, replaces: body.replaces });
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
