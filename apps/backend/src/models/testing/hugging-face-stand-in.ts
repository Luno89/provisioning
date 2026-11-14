import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ChatTemplateFile } from '../lib/chat-templates.js';
import { chatTemplateFixture } from './chat-templates.js';

export interface StandInModel {
  template?: string;
  fixture?: string;
  as?: ChatTemplateFile;
  needsToken?: string;
  answers?: number;
}

export interface HuggingFaceStandIn {
  url: string;
  asked: { path: string; token: string | undefined }[];
  close(): Promise<void>;
}

const bodyFor = (model: StandInModel, file: ChatTemplateFile): string | undefined => {
  const template = model.template ?? (model.fixture ? chatTemplateFixture(model.fixture) : undefined);
  if (template === undefined || (model.as ?? 'chat_template.jinja') !== file) return undefined;
  return file === 'chat_template.jinja' ? template : JSON.stringify({ chat_template: template });
};

export async function startHuggingFaceStandIn(models: Record<string, StandInModel>): Promise<HuggingFaceStandIn> {
  const asked: HuggingFaceStandIn['asked'] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://stand-in').pathname;
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    asked.push({ path, token });
    const found = /^\/([^/]+\/[^/]+)\/resolve\/main\/([^/]+)$/.exec(path);
    const model = found ? models[found[1]!] : undefined;
    if (!found || !model || (model.needsToken !== undefined && model.needsToken !== token)) {
      response.statusCode = 401;
      response.end('{"error":"Invalid credentials in Authorization header"}');
      return;
    }
    if (model.answers !== undefined) {
      response.statusCode = model.answers;
      response.end();
      return;
    }
    const body = bodyFor(model, found[2] as ChatTemplateFile);
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body ?? 'Entry not found');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}
