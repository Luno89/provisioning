import type { RequestListener } from 'node:http';
import { inject, type InjectOptions, type Response as Injected } from 'light-my-request';
import { keptThroughExpress } from './routes.js';

export const injectedFetch = (app: RequestListener): typeof fetch => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, name) => { headers[name] = value; });
  const body = init?.body ?? undefined;
  const options = {
    method: (init?.method ?? 'GET') as InjectOptions['method'],
    url: `${url.pathname}${url.search}`,
    headers: { host: url.host, ...headers },
    ...(body === undefined || body === null ? {} : { payload: body instanceof URLSearchParams ? body.toString() : body as string }),
  } as InjectOptions;
  const answer: Injected = await inject((req, res) => {
    keptThroughExpress(req);
    keptThroughExpress(res);
    app(req, res);
  }, options);
  const answered = new Headers();
  for (const [name, value] of Object.entries(answer.headers)) {
    for (const one of [value ?? []].flat()) answered.append(name, String(one));
  }
  const empty = answer.statusCode === 204 || answer.statusCode === 304 || (answer.statusCode >= 300 && answer.statusCode < 400 && !answer.rawPayload.length);
  const response = new Response(empty ? null : new Uint8Array(answer.rawPayload), { status: answer.statusCode, headers: answered });
  Object.defineProperty(response, 'url', { value: url.href });
  return response;
};
