import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DependencyDownError } from '../lib/dependencies.js';
import { asyncRoute, errorResponder } from './async-route.js';

function answered() {
  const res = mock<Response>();
  (res as { headersSent: boolean }).headersSent = false;
  res.status.mockReturnValue(res);
  return res;
}

describe('what a route answers when it fails', () => {
  it('answers a dependency that is down with 503, naming it, since when and why', () => {
    const res = answered();
    errorResponder(new DependencyDownError('gitea', '2026-11-08T10:02:00.000Z', 'it refused the connection (ECONNREFUSED)'), mock<Request>(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Gitea isn\'t answering since 10:02 UTC: it refused the connection (ECONNREFUSED)',
      dependency: 'gitea',
      since: '2026-11-08T10:02:00.000Z',
      reason: 'it refused the connection (ECONNREFUSED)',
    });
  });

  it('answers any other failure with its own status, or 500, and its message', () => {
    const res = answered();
    errorResponder(Object.assign(new Error('not yours'), { status: 404 }), mock<Request>(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'not yours' });
    const other = answered();
    errorResponder(new Error('broke'), mock<Request>(), other, vi.fn());
    expect(other.status).toHaveBeenCalledWith(500);
  });

  it('hands a failure on when the answer already started, and an async handler\'s rejection to the next handler', async () => {
    const res = answered();
    (res as { headersSent: boolean }).headersSent = true;
    const next = vi.fn<NextFunction>();
    const failure = new Error('late');
    errorResponder(failure, mock<Request>(), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(failure);
    const passed = vi.fn<NextFunction>();
    asyncRoute(async () => { throw failure; })(mock<Request>(), answered(), passed as unknown as NextFunction);
    await vi.waitFor(() => expect(passed).toHaveBeenCalledWith(failure));
  });
});
