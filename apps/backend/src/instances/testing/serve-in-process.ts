import { IncomingMessage, ServerResponse, type RequestListener } from 'node:http';
import { Socket } from 'node:net';

export async function serveInProcess(app: RequestListener, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const socket = new Socket();
  if (url.protocol === 'https:') Object.assign(socket, { encrypted: true });
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = { host: url.host };
  request.headers.forEach((value, name) => { headers[name] = value; });
  req.headers = headers;
  const payload = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
  if (payload && payload.length > 0) req.headers['content-length'] = String(payload.length);

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
  if (payload && payload.length > 0) req.push(payload);
  req.push(null);
  await finished;
  socket.destroy();

  const answered = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (Array.isArray(value)) value.forEach((entry) => answered.append(name, entry));
    else if (value !== undefined) answered.set(name, String(value));
  }
  const status = res.statusCode;
  const bodyless = status === 204 || status === 304 || (status >= 300 && status < 400 && chunks.length === 0);
  return new Response(bodyless ? null : Buffer.concat(chunks), { status, headers: answered });
}
