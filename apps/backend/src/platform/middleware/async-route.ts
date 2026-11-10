import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import { DependencyDownError } from '../lib/dependencies.js';
import { failedHere } from '@koala/engine-core/telemetry';

export function asyncRoute<P = ParamsDictionary>(
  handler: (req: Request<P>, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler<P> {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function errorResponder(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  failedHere(err);
  if (res.headersSent) return next(err);
  if (err instanceof DependencyDownError) {
    res.status(503).json({ error: err.message, dependency: err.dependency, since: err.since, reason: err.reason });
    return;
  }
  res.status(err.status ?? 500).json({ error: err.message });
}
