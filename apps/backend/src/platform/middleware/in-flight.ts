import type { RequestHandler } from 'express';
import { InFlightLimits, limitedAddress, limitedPath } from '../lib/in-flight-limits.js';

export function inFlightLimit(limits: InFlightLimits = new InFlightLimits()): RequestHandler {
  return (req, res, next) => {
    const address = req.ip ?? req.socket.remoteAddress ?? '';
    if (!limitedAddress(address) || !limitedPath(req.path)) return next();
    if (!limits.enter(address)) {
      res.status(429).json({ error: 'Too many requests from your address are still open; try again once some have finished.' });
      return;
    }
    const started = process.hrtime.bigint();
    const writeHead = res.writeHead;
    let timed = false;
    res.writeHead = function timedWriteHead(this: typeof res, ...args: Parameters<typeof writeHead>) {
      if (!timed) {
        timed = true;
        limits.answered(Number(process.hrtime.bigint() - started) / 1e9);
      }
      return writeHead.apply(this, args);
    } as typeof writeHead;
    res.once('close', () => limits.leave(address));
    next();
  };
}
