import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async handler so a rejected promise reaches Express instead of vanishing.
 *
 * ── WHY EVERY HANDLER NEEDS THIS ──
 * Express 4 does not await handlers. An async handler that rejects produces an unhandled rejection
 * and never responds — the client hangs until it times out, and the server logs nothing useful. The
 * defence in index.ts was to wrap all ~150 handlers in an identical
 * `try { … } catch (err: any) { res.status(500).json({ error: err.message }) }`, which works and
 * costs five lines per route, obscures the two lines that are actually about the route, and is one
 * `catch` block away from a hang the next time someone adds a handler in a hurry.
 *
 * With this, forgetting is not possible: an unwrapped async handler is visibly different from every
 * other line in the file.
 *
 * ── WHY IT FORWARDS RATHER THAN RESPONDING ──
 * `next(err)` hands the error to the app's error middleware, so the shape of a failure response is
 * decided in ONE place. Responding here would put that decision in 150 places again, just with
 * fewer characters.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Turns an error into a JSON body. Mounted last, after every router.
 *
 * ── STATUS CODE ──
 * A handler that wants a specific status says so by responding itself; anything that reaches here
 * threw, and a thrown error is a 500 unless it carries a `status`. That escape hatch exists because
 * some failures genuinely are the caller's fault (a bad id, a missing field) and deserve a 4xx —
 * but it has to be explicit, or every unexpected bug starts reporting as a client error.
 *
 * ── WHY THE MESSAGE IS FORWARDED ──
 * Consistent with what the 150 hand-written handlers already did, and the frontend's
 * `errorMessage()` reads exactly this field. Note this DOES surface internal messages to the
 * client; that is the existing behaviour and changing it is a separate decision, not one to make
 * silently in a refactor.
 */
export function errorResponder(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the 4-arity signature to recognise this as error middleware, and if a response
  // has already started, the only correct move is to let Express destroy the socket.
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.message });
}
