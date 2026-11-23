import type { Request, RequestHandler, Response } from 'express';

export interface Guarded {
  statusCode: number;
  body: unknown;
  nexted: boolean;
}

export const guardedBy = (guard: RequestHandler, req: Request): Promise<Guarded> => new Promise((resolve, reject) => {
  const seen: Guarded = { statusCode: 0, body: undefined, nexted: false };
  const res = {
    status(code: number) { seen.statusCode = code; return this; },
    json(payload: unknown) { seen.body = payload; resolve(seen); return this; },
  } as unknown as Response;
  guard(req, res, (err?: unknown) => {
    if (err) reject(err instanceof Error ? err : new Error(String(err)));
    else {
      seen.nexted = true;
      resolve(seen);
    }
  });
});
