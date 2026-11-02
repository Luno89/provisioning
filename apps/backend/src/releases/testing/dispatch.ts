import express, { type Router } from 'express';
import { IncomingMessage, ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { principalOf, type ClaimSettings } from '../../platform/lib/permissions.js';
import { errorResponder } from '../../platform/middleware/async-route.js';
import type { PlatformGrant } from '../../platform/lib/types.js';

export interface DispatchedUser { id: string; email: string; roles?: PlatformGrant[] | undefined }

export interface Dispatch {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  prefix?: string | undefined;
  json?: unknown;
  body?: Buffer | Readable | undefined;
  headers?: IncomingHttpHeaders | undefined;
  user?: DispatchedUser | undefined;
  claims?: ClaimSettings | undefined;
}

export interface Dispatched {
  status: number;
  headers: OutgoingHttpHeaders;
  bytes: Buffer;
  text: string;
  json: unknown;
}

export const SIGNED_IN: DispatchedUser = { id: 'test-user', email: 'test@example.com' };

export async function dispatch(router: Router, request: Dispatch): Promise<Dispatched> {
  const app = express();
  const user = request.user ?? SIGNED_IN;
  app.use(express.json({ limit: '20mb' }));
  app.use((req, _res, next) => {
    Object.assign(req, { user, principal: principalOf(user, request.claims ?? { role: 'combined' }) });
    next();
  });
  app.use(request.prefix ?? '/', router);
  app.use(errorResponder);

  const req = new IncomingMessage(new Socket());
  req.method = request.method;
  req.url = request.url;
  req.headers = { host: 'koala.test', ...request.headers };
  const body = request.json === undefined ? request.body : Buffer.from(JSON.stringify(request.json));
  if (request.json !== undefined) req.headers['content-type'] = 'application/json';
  if (Buffer.isBuffer(body)) req.headers['content-length'] = String(body.length);
  if (body instanceof Readable) req.headers['transfer-encoding'] = 'chunked';
  if (body instanceof Readable) body.on('data', (chunk: Buffer) => req.push(chunk)).on('end', () => req.push(null));
  else {
    if (body) req.push(body);
    req.push(null);
  }

  const res = new ServerResponse(req);
  const parts: Buffer[] = [];
  const finished = new Promise<void>((resolve) => {
    res.write = ((chunk: string | Buffer) => {
      parts.push(Buffer.from(chunk));
      return true;
    }) as ServerResponse['write'];
    res.end = ((chunk?: string | Buffer) => {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) parts.push(Buffer.from(chunk));
      resolve();
      return res;
    }) as ServerResponse['end'];
  });
  app(req, res);
  await finished;
  const bytes = Buffer.concat(parts);
  const text = bytes.toString('utf8');
  const asJson = String(res.getHeader('content-type') ?? '').includes('json');
  return { status: res.statusCode, headers: res.getHeaders(), bytes, text, json: asJson ? (JSON.parse(text) as unknown) : undefined };
}
