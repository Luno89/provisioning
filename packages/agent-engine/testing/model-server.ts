import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface Asked {
  path: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
  at: number;
  endedAt: number | undefined;
  closed: Promise<void>;
}

export type Answer = (response: http.ServerResponse, asked: Asked) => void;

export interface ModelServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly asked: Asked[];
  readonly modelsAsked: number;
  readonly mostAtOnce: number;
  answerNext(...answers: Answer[]): void;
  modelsAnswerNext(...statuses: number[]): void;
  nextAsk(): Promise<Asked>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const frame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;

export const delta = (part: Record<string, unknown>, finish: string | null = null): string =>
  frame({ id: 'stand-in', object: 'chat.completion.chunk', created: 0, model: 'stand-in', choices: [{ index: 0, delta: part, finish_reason: finish }] });

export const streamed = (...frames: string[]): Answer => (response) => {
  response.setHeader('content-type', 'text/event-stream');
  for (const written of frames) response.write(written);
  response.end('data: [DONE]\n\n');
};

export const cutAfter = (...frames: string[]): Answer => (response) => {
  response.setHeader('content-type', 'text/event-stream');
  response.flushHeaders();
  for (const written of frames) response.write(written);
  response.socket?.destroy();
};

export const leftOpen = (...frames: string[]): Answer => (response) => {
  response.setHeader('content-type', 'text/event-stream');
  response.flushHeaders();
  for (const written of frames) response.write(written);
};

export const refused = (status: number, body: string, headers: Record<string, string> = {}): Answer => (response) => {
  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
};

export const held = (): { answer: Answer; release(next: Answer): void } => {
  const waiting: { response: http.ServerResponse; asked: Asked }[] = [];
  let then: Answer | undefined;
  return {
    answer: (response, asked) => {
      if (then) then(response, asked);
      else waiting.push({ response, asked });
    },
    release: (next) => {
      then = next;
      for (const { response, asked } of waiting.splice(0)) next(response, asked);
    },
  };
};

export async function modelServer(options: { port?: number; listening?: boolean } = {}): Promise<ModelServer> {
  const asked: Asked[] = [];
  const answers: Answer[] = [];
  const modelStatuses: number[] = [];
  const sockets = new Set<Socket>();
  const told = new EventEmitter();
  let modelsAsked = 0;
  let atOnce = 0;
  let mostAtOnce = 0;
  let port = options.port ?? 0;

  const server = http.createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://stand-in').pathname;
      if (request.method === 'GET' && path.endsWith('/models')) {
        modelsAsked += 1;
        response.statusCode = modelStatuses.shift() ?? 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'stand-in', object: 'model' }] }));
        return;
      }
      if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
        response.statusCode = 404;
        response.end(`nothing is served at ${request.method} ${path}`);
        return;
      }
      atOnce += 1;
      mostAtOnce = Math.max(mostAtOnce, atOnce);
      const ask: Asked = {
        path,
        body: JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>,
        authorization: request.headers.authorization,
        at: Date.now(),
        endedAt: undefined,
        closed: once(response, 'close').then(() => undefined),
      };
      void ask.closed.then(() => {
        atOnce -= 1;
        ask.endedAt = Date.now();
      });
      asked.push(ask);
      told.emit('asked', ask);
      const answer = answers.shift();
      if (answer) answer(response, ask);
      else refused(500, 'the stand-in was asked more often than the test scripted an answer')(response, ask);
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

  const stop = async () => {
    if (!server.listening) return;
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  };

  if (options.listening ?? true) await start();

  return {
    get port() { return port; },
    get baseUrl() { return `http://127.0.0.1:${port}/v1`; },
    asked,
    get modelsAsked() { return modelsAsked; },
    get mostAtOnce() { return mostAtOnce; },
    answerNext: (...next) => { answers.push(...next); },
    modelsAnswerNext: (...statuses) => { modelStatuses.push(...statuses); },
    nextAsk: async () => {
      const [ask] = await once(told, 'asked') as [Asked];
      return ask;
    },
    start,
    stop,
  };
}

