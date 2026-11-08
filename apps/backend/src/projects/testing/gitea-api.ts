import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { GiteaService } from '../services/GiteaService.js';

export interface GiteaStandIn {
  gitea(): GiteaService;
  asked: string[];
  close(): Promise<void>;
}


export async function giteaStandIn(repo: { owner: string; name: string; commit: string; files: Record<string, string> }): Promise<GiteaStandIn> {
  const asked: string[] = [];
  const prefix = `/api/v1/repos/${repo.owner}/${repo.name}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gitea.test');
    asked.push(`${request.method} ${url.pathname} ${request.headers.authorization ?? ''}`);
    if (url.pathname === `${prefix}/git/trees/${repo.commit}`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ tree: Object.keys(repo.files).map((file) => ({ path: file, type: 'blob' })) }));
      return;
    }
    const raw = url.pathname.startsWith(`${prefix}/raw/`) ? url.pathname.slice(`${prefix}/raw/`.length) : undefined;
    if (raw && url.searchParams.get('ref') === repo.commit && repo.files[raw] !== undefined) {
      response.end(repo.files[raw]);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    asked,
    gitea() {
      const service = new GiteaService('master-key' as never, { url: baseUrl });
      const internals = service as unknown as { getToken(): Promise<string> };
      vi.spyOn(internals, 'getToken').mockResolvedValue('bot-token');
      return service;
    },
    close: () => new Promise((done) => { server.close(() => done()); }),
  };
}
