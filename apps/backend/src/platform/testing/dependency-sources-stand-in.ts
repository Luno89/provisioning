import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DependencySourcesStandIn {
  url: string;
  asked: string[];
  close(): Promise<void>;
}

export interface Advisories {
  found?: Record<string, string[]>;
  records?: Record<string, unknown>;
  answers?: Record<string, unknown>;
  down?: string[];
}

export async function startDependencySourcesStandIn(advisories: Advisories = {}): Promise<DependencySourcesStandIn> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      asked.push(`${request.method} ${request.url}`);
      if (advisories.down?.some((prefix) => (request.url ?? '').startsWith(prefix))) {
        response.writeHead(503, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.method === 'POST' && request.url === '/osv/querybatch') {
        const { queries } = JSON.parse(body || '{}') as { queries?: { package: { name: string }; version: string }[] };
        const results = (queries ?? []).map((query) => {
          const ids = advisories.found?.[`${query.package.name}@${query.version}`] ?? [];
          return ids.length ? { vulns: ids.map((id) => ({ id })) } : {};
        });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
        return;
      }
      const vuln = /^\/osv\/vulns\/(.+)$/.exec(request.url ?? '')?.[1];
      const answer = vuln ? advisories.records?.[decodeURIComponent(vuln)] : advisories.answers?.[request.url ?? ''];
      if (answer !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
