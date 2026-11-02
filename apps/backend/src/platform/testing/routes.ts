import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { inject } from 'light-my-request';
import type { Database } from '../lib/db-interface.js';
import { harnessApp, TEST_USER, type HarnessOptions, type HarnessUser } from '../routes/test-harness.js';
import { memoryDatabase } from './memory-database.js';

export const PERSON: HarnessUser = { id: 'person-1', email: 'person@example.com' };
export const OPERATOR: HarnessUser = { id: 'operator-1', email: 'operator@example.com', roles: ['operator'] };

export interface RouteAnswer<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  bytes: Buffer;
  data: T;
}

export interface RouteRequest {
  body?: unknown;
  raw?: string | Buffer | Readable | undefined;
  headers?: Record<string, string> | undefined;
  user?: HarnessUser | null | undefined;
  hangUp?: Promise<void> | undefined;
}

export interface InProcessRoutes {
  db: Database;
  setUser: (user: HarnessUser | null) => void;
  request: <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, request?: RouteRequest) => Promise<RouteAnswer<T>>;
  get: <T = unknown>(path: string, request?: RouteRequest) => Promise<RouteAnswer<T>>;
  post: <T = unknown>(path: string, body?: unknown, request?: RouteRequest) => Promise<RouteAnswer<T>>;
  put: <T = unknown>(path: string, body?: unknown, request?: RouteRequest) => Promise<RouteAnswer<T>>;
  patch: <T = unknown>(path: string, body?: unknown, request?: RouteRequest) => Promise<RouteAnswer<T>>;
  delete: <T = unknown>(path: string, request?: RouteRequest) => Promise<RouteAnswer<T>>;
}

const keptThroughExpress = (target: object): void => {
  const own = Object.getPrototypeOf(target) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(own)) {
    if (name !== 'constructor' && typeof own[name] === 'function') Object.defineProperty(target, name, { value: own[name], writable: true, configurable: true });
  }
};

const parsed = (text: string): unknown => {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const hangUpWhen = (res: ServerResponse, hangUp: Promise<void>): void => {
  const lightMyRequestsOwn = res.rawListeners('close') as Array<() => void>;
  res.removeAllListeners('close');
  void hangUp.then(() => setTimeout(() => {
    res.emit('close');
    for (const listener of lightMyRequestsOwn) res.once('close', listener);
  }, 0));
};

export async function routesInProcess(opts: HarnessOptions & { db?: Database }): Promise<InProcessRoutes> {
  const db = opts.db ?? memoryDatabase();
  let current: HarnessUser | null = opts.user === undefined ? TEST_USER : opts.user;
  const askedAs = new WeakMap<object, HarnessUser | null>();
  const app = await harnessApp(opts, db, (req) => (askedAs.has(req) ? askedAs.get(req) ?? null : current));
  const request = async <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, sent: RouteRequest = {}): Promise<RouteAnswer<T>> => {
    const json = sent.body !== undefined && sent.raw === undefined;
    const answer = await inject((req, res) => {
      keptThroughExpress(req);
      keptThroughExpress(res);
      if (sent.user !== undefined) askedAs.set(req, sent.user);
      if (sent.hangUp) hangUpWhen(res, sent.hangUp);
      app(req, res);
    }, {
      method,
      url: path,
      headers: { host: 'koala.test', ...(typeof sent.raw === 'object' && !Buffer.isBuffer(sent.raw) ? { 'transfer-encoding': 'chunked' } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...sent.headers },
      ...(json ? { payload: JSON.stringify(sent.body) } : sent.raw !== undefined ? { payload: sent.raw } : {}),
    });
    return { status: answer.statusCode, headers: answer.headers, text: answer.payload, bytes: answer.rawPayload, data: parsed(answer.payload) as T };
  };
  return {
    db,
    setUser: (user) => { current = user; },
    request,
    get: (path, sent) => request('GET', path, sent),
    post: (path, body, sent) => request('POST', path, { ...sent, body }),
    put: (path, body, sent) => request('PUT', path, { ...sent, body }),
    patch: (path, body, sent) => request('PATCH', path, { ...sent, body }),
    delete: (path, sent) => request('DELETE', path, sent),
  };
}
