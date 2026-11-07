import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface Received {
  path: string;
  contentType: string | undefined;
  body: unknown;
}

export interface Collector {
  readonly url: string;
  readonly received: Received[];
  answerWith(status: number): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function collector(options: { port?: number; listening?: boolean } = {}): Promise<Collector> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  let status = 200;
  let port = options.port ?? 0;
  const server = http.createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      if (status === 200) {
        received.push({
          path: new URL(request.url ?? '/', 'http://collector').pathname,
          contentType: request.headers['content-type'],
          body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown,
        });
      }
      response.statusCode = status;
      response.end('{}');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const start = async () => {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  };
  if (options.listening ?? true) await start();
  return {
    get url() { return `http://127.0.0.1:${port}`; },
    received,
    answerWith: (next) => { status = next; },
    start,
    stop: async () => {
      if (!server.listening) return;
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

