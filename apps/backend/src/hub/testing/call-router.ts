import express, { type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { errorResponder } from '../../platform/middleware/async-route.js';

export interface CallingUser { id: string; email: string }

export interface RouterCall {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  user?: CallingUser | undefined;
  hangUp?: Promise<void> | undefined;
}

export interface RouterAnswer {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  bytes: Buffer;
  text: string;
  body: unknown;
}

export async function callRouter(router: Router, prefix: string, call: RouterCall): Promise<RouterAnswer> {
  const app = express();
  app.use((req, _res, next) => {
    if (call.user) (req as unknown as { user: CallingUser }).user = call.user;
    next();
  });
  app.use(express.json());
  app.use(prefix, router);
  app.use(errorResponder);

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = call.method ?? 'GET';
  req.url = `${prefix}${call.path}`;
  req.headers = { host: 'koala.test', ...call.headers };
  const payload = call.json !== undefined ? Buffer.from(JSON.stringify(call.json)) : call.bytes;
  if (call.json !== undefined) req.headers['content-type'] = 'application/json';
  if (payload) req.headers['content-length'] = String(payload.length);

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
  void call.hangUp?.then(() => setTimeout(() => res.emit('close'), 0));

  app(req, res);
  if (payload) req.push(payload);
  req.push(null);
  await finished;
  socket.destroy();

  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  let body: unknown = text;
  try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
  return { status: res.statusCode, headers: res.getHeaders(), bytes, text, body };
}
