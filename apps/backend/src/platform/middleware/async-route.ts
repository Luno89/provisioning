import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';

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
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.message });
}
