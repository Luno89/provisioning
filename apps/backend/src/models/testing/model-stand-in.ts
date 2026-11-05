import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ModelStandIn {
  baseUrl: string;
  model: string;
  asked: string[];
  waiting(): number;
  release(): void;
  close(): Promise<void>;
}

const chunk = (model: string, delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'stand-in', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

export async function startModelStandIn(answer: string, options: { holding?: boolean; model?: string } = {}): Promise<ModelStandIn> {
  const model = options.model ?? 'stand-in';
  const asked: string[] = [];
  const held: (() => void)[] = [];
  let holding = options.holding ?? false;
  const reply = (asking: { stream?: boolean }, response: http.ServerResponse) => {
    if (response.destroyed) return;
    if (!asking.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'stand-in', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.write(chunk(model, { role: 'assistant', content: '' }));
    for (const word of answer.split(/(?<= )/)) response.write(chunk(model, { content: word }));
    response.write(chunk(model, {}, 'stop'));
    response.end('data: [DONE]\n\n');
  };
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((request, response) => {
    const body: Buffer[] = [];
    request.on('data', (part: Buffer) => body.push(part));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://stand-in').pathname;
      if (request.method === 'GET' && path.endsWith('/models')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      if (request.method === 'POST' && path.endsWith('/chat/completions')) {
        const asking = JSON.parse(Buffer.concat(body).toString('utf8') || '{}') as { stream?: boolean; messages?: { role: string; content: unknown }[] };
        const last = [...(asking.messages ?? [])].reverse().find((message) => message.role === 'user');
        asked.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
        if (holding) held.push(() => reply(asking, response));
        else reply(asking, response);
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model,
    asked,
    waiting: () => held.length,
    release: () => {
      holding = false;
      for (const answering of held.splice(0)) answering();
    },
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}
