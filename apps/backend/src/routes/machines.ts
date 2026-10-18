import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { joinEnv } from '../lib/machines.js';
import type { MachineService } from '../services/MachineService.js';
import { GIT_ROUTES, type GitRoute, type MachineGitService } from '../services/MachineGitService.js';

const bearer = (header: string | undefined): string | undefined => header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

export function machinesRouter(deps: { machines: Pick<MachineService, 'join'>; bundle: () => Promise<string>; git?: Pick<MachineGitService, 'serve'> | undefined }): Router {
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
    if (req.query.format === 'env') return res.type('text/plain').send(joinEnv(outcome.value.env));
    res.json(outcome.value);
  }));

  router.get('/agent.tgz', asyncRoute(async (_req: Request, res: Response) => {
    res.type('application/gzip').sendFile(await deps.bundle());
  }));

  return router;
}
