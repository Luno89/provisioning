import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DependencySourcesStandIn {
  url: string;
  asked: string[];
  close(): Promise<void>;
}

export async function startDependencySourcesStandIn(): Promise<DependencySourcesStandIn> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      asked.push(`${request.method} ${request.url}`);
      if (request.method === 'POST' && request.url === '/osv/querybatch') {
        const { queries } = JSON.parse(body || '{}') as { queries?: unknown[] };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: (queries ?? []).map(() => ({})) }));
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
