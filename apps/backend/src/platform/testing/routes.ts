import { inject } from 'light-my-request';
import type { Database } from '../lib/db-interface.js';
import { harnessApp, TEST_USER, type HarnessOptions, type HarnessUser } from '../routes/test-harness.js';
import { memoryDatabase } from './memory-database.js';

export interface RouteAnswer<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  data: T;
}

export interface RouteRequest {
  body?: unknown;
  raw?: string | Buffer | undefined;
  headers?: Record<string, string> | undefined;
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

export async function routesInProcess(opts: HarnessOptions & { db?: Database }): Promise<InProcessRoutes> {
  const db = opts.db ?? memoryDatabase();
  let current: HarnessUser | null = opts.user === undefined ? TEST_USER : opts.user;
  const app = await harnessApp(opts, db, () => current);
  const request = async <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, sent: RouteRequest = {}): Promise<RouteAnswer<T>> => {
    const json = sent.body !== undefined && sent.raw === undefined;
    const answer = await inject((req, res) => { keptThroughExpress(req); keptThroughExpress(res); app(req, res); }, {
      method,
      url: path,
      headers: { host: 'koala.test', ...(json ? { 'content-type': 'application/json' } : {}), ...sent.headers },
      ...(json ? { payload: JSON.stringify(sent.body) } : sent.raw !== undefined ? { payload: sent.raw } : {}),
    });
    return { status: answer.statusCode, headers: answer.headers, text: answer.payload, data: parsed(answer.payload) as T };
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
