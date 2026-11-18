import { setupServer } from 'msw/node';
import type { RequestHandler } from 'msw';
import { afterAll, afterEach, beforeAll } from 'vitest';
export { http, HttpResponse } from 'msw';

export function interceptHttp(...handlers: RequestHandler[]): ReturnType<typeof setupServer> {
  const server = setupServer(...handlers);
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}
