import express, { type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { errorResponder } from '../../platform/middleware/async-route.js';
import { principalOf, type ClaimSettings } from '../../platform/lib/permissions.js';
import type { UserMetadata } from '../../platform/lib/types.js';

export type CallingUser = Pick<UserMetadata, 'id' | 'email'> & Partial<UserMetadata>;

export const PERSON: CallingUser = { id: 'person-1', email: 'person@example.com' };
export const OPERATOR: CallingUser = { id: 'operator-1', email: 'operator@example.com', roles: ['operator'] };

export interface RouterCall {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path?: string;
  body?: unknown;
  user?: CallingUser | null;
  claims?: ClaimSettings;
  headers?: Record<string, string>;
}

export interface RouterAnswer {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  body: unknown;
}

export async function callRouter(router: Router, prefix: string, call: RouterCall): Promise<RouterAnswer> {
  const app = express();
  const user = call.user === undefined ? PERSON : call.user;
  app.use((req, _res, next) => {
    if (user) {
      const carrier = req as unknown as { user: CallingUser; principal: ReturnType<typeof principalOf>; body: unknown };
      carrier.user = user;
      carrier.principal = principalOf(user, call.claims ?? { role: 'combined' });
    }
    next();
  });
  app.use(express.json());
  app.use(prefix, router);
  app.use(errorResponder);

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = call.method ?? 'GET';
  req.url = `${prefix}${call.path ?? ''}`;
  req.headers = { host: 'koala.test', ...call.headers };
  const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
  if (payload !== undefined) {
    req.headers['content-type'] = 'application/json';
    req.headers['content-length'] = String(Buffer.byteLength(payload));
  }

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve) => {
    const take = (chunk: unknown): void => {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    };
    res.write = ((chunk: unknown) => { take(chunk); return true; }) as typeof res.write;
    res.end = ((chunk?: unknown) => { take(chunk); resolve(); return res; }) as typeof res.end;
  });

  app(req, res);
  if (payload !== undefined) req.push(payload);
  req.push(null);
  await finished;
  socket.destroy();

  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text;
  try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
  return { status: res.statusCode, headers: res.getHeaders(), text, body };
}
