import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Database } from '../../platform/lib/db-interface.js';
import { principalOf } from '../../platform/lib/permissions.js';
import { errorResponder } from '../../platform/middleware/async-route.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';

export interface InProcessUser { id: string; email: string }

export const PERSON: InProcessUser = { id: 'test-user', email: 'test@example.com' };

export interface InProcessReply<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface InProcess {
  db: Database;
  setUser: (user: InProcessUser | null) => void;
  get: <T = unknown>(path: string) => Promise<InProcessReply<T>>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<InProcessReply<T>>;
  put: <T = unknown>(path: string, body?: unknown) => Promise<InProcessReply<T>>;
  patch: <T = unknown>(path: string, body?: unknown) => Promise<InProcessReply<T>>;
  delete: <T = unknown>(path: string) => Promise<InProcessReply<T>>;
}

export interface InProcessOptions {
  router: (db: Database) => Router | Promise<Router>;
  prefix: string;
  user?: InProcessUser | null;
  db?: Database;
}

const textOf = (chunk: unknown): string => {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
};

export async function mountInProcess(options: InProcessOptions): Promise<InProcess> {
  const db = options.db ?? memoryDatabase();
  let current: InProcessUser | null = options.user === undefined ? PERSON : options.user;

  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!current) {
      res.status(401).json({ error: 'Session missing' });
      return;
    }
    Object.assign(req, { user: current, principal: principalOf(current, { role: 'combined' }) });
    next();
  });
  app.use(options.prefix, await options.router(db));
  app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'Not found' }); });
  app.use(errorResponder);

  const send = (method: string, path: string, body: unknown): Promise<InProcessReply> => new Promise((resolve) => {
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = path;
    req.headers = { 'content-type': 'application/json' };
    Object.assign(req, { body });
    const res = new ServerResponse(req);
    let written = '';
    Object.assign(res, {
      write(chunk: unknown) {
        written += textOf(chunk);
        return true;
      },
      end(chunk?: unknown) {
        written += textOf(chunk);
        const type = String(res.getHeader('content-type') ?? '');
        resolve({ status: res.statusCode, data: type.includes('json') && written ? JSON.parse(written) as unknown : written, headers: res.getHeaders() });
        return res;
      },
    });
    app(req, res);
  });

  const typed = async <T>(method: string, path: string, body?: unknown): Promise<InProcessReply<T>> => {
    const reply = await send(method, path, body);
    return { ...reply, data: reply.data as T };
  };

  return {
    db,
    setUser: (user) => { current = user; },
    get: (path) => typed('GET', path),
    post: (path, body) => typed('POST', path, body ?? {}),
    put: (path, body) => typed('PUT', path, body ?? {}),
    patch: (path, body) => typed('PATCH', path, body ?? {}),
    delete: (path) => typed('DELETE', path),
  };
}
