import express, { type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { errorResponder } from '../../platform/middleware/async-route.js';
import { principalOf, type ClaimedUser, type ClaimSettings } from '../../platform/lib/permissions.js';

export type CallingUser = ClaimedUser & { email: string };

export const CALLER: CallingUser = { id: 'test-user', email: 'test@example.com' };

export interface RouteCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  user?: CallingUser | undefined;
  claims?: ClaimSettings | undefined;
}

export interface RouteAnswer {
  status: number;
  body: unknown;
}

export function callRouter(router: Router, call: RouteCall): Promise<RouteAnswer> {
  const user = call.user ?? CALLER;
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { body: call.body, user, principal: principalOf(user, call.claims ?? { role: 'combined' }) });
    next();
  });
  app.use(router);
  app.use(errorResponder);

  const req = new IncomingMessage(new Socket());
  req.method = call.method;
  req.url = call.path;
  const res = new ServerResponse(req);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.write = ((chunk: string | Buffer) => { chunks.push(Buffer.from(chunk)); return true; }) as typeof res.write;
    res.end = ((chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      resolve({ status: res.statusCode, body });
      return res;
    }) as typeof res.end;
    app(req, res);
  });
}

export const get = (router: Router, path: string, user?: CallingUser): Promise<RouteAnswer> => callRouter(router, { method: 'GET', path, user });
export const post = (router: Router, path: string, body?: unknown, user?: CallingUser): Promise<RouteAnswer> => callRouter(router, { method: 'POST', path, body, user });
export const put = (router: Router, path: string, body?: unknown, user?: CallingUser): Promise<RouteAnswer> => callRouter(router, { method: 'PUT', path, body, user });
export const patch = (router: Router, path: string, body?: unknown, user?: CallingUser): Promise<RouteAnswer> => callRouter(router, { method: 'PATCH', path, body, user });
export const del = (router: Router, path: string, body?: unknown, user?: CallingUser): Promise<RouteAnswer> => callRouter(router, { method: 'DELETE', path, body, user });
