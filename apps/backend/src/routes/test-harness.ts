import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import axios from 'axios';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';

/**
 * Mounts ONE router on a bare Express app, so a route can be tested over real HTTP.
 *
 * ── WHY THIS EXISTS ──
 * 145 of the 150 routes in index.ts have no HTTP-level coverage at all. The reason is mechanical
 * rather than negligent: until routers existed there was nothing smaller than the whole application
 * to mount, so `routes.test.ts` boots `bootstrap()` — which constructs eighteen services, opens a
 * Temporal connection, starts a reconciliation loop and sweeps workbench pods — in order to assert
 * that an unauthenticated GET returns 401. That is slow, it needs a live environment, and it means
 * a route's own behaviour is never the thing under test.
 *
 * With a router factory (see `B6` in the plan) a test needs the router, a stub user and a database.
 * Nothing else. No Temporal, no sockets, no cluster.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 * It does not replace `routes.test.ts`. That file is the only check that the real application still
 * assembles — every router extraction changes `bootstrap()`, and a router that works in isolation
 * while `bootstrap()` throws is a green suite and a dead server. Keep both.
 *
 * It also does not stub the database. `createDatabase()` returns `MemoryDB` under `NODE_ENV=test`,
 * which is a real implementation of the real interface — a hand-written stub would drift from it,
 * and the memory/Mongo divergence has already cost one outage (see `lib/mongo-roundtrip.test.ts`).
 */

/** The user every request arrives as, unless a test says otherwise. */
export const TEST_USER = { id: 'test-user', email: 'test@example.com', isAdmin: false };

export interface HarnessOptions {
  /**
   * Builds the router under test. Receives the database so a factory can be given whatever service
   * it needs; the test constructs those itself, which is the point — it sees exactly what the route
   * depends on.
   */
  router: (db: Database) => Router | Promise<Router>;
  /** Where to mount it. Matches the prefix used in `bootstrap()`, e.g. `/api/credentials`. */
  prefix: string;
  /**
   * Who the request is from. `null` means unauthenticated, so a test can assert the 401 path — the
   * real `requireAuth` is not mounted here, and asserting authorization is the router's own job.
   */
  user?: typeof TEST_USER | null;
}

export interface Harness {
  url: (path: string) => string;
  db: Database;
  /** Swap the caller mid-test, to check one tenant cannot read another's records. */
  setUser: (user: typeof TEST_USER | null) => void;
  close: () => Promise<void>;
}

export async function mountRouter(opts: HarnessOptions): Promise<Harness> {
  axios.defaults.proxy = false;
  const db = createDatabase();
  await db.init();

  let current: typeof TEST_USER | null = opts.user === undefined ? TEST_USER : opts.user;

  const app = express();
  app.use(express.json());

  /**
   * Stands in for `requireAuth`. It is deliberately dumber than the real one: this harness is for
   * testing what a route DOES once a user is established, and re-implementing session parsing here
   * would be a second, weaker copy of the middleware — the same mistake the two shadow-copy security
   * tests made (see `lib/ownership.ts`).
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!current) return res.status(401).json({ error: 'Session missing' });
    (req as unknown as { user: typeof TEST_USER }).user = current;
    next();
  });

  app.use(opts.prefix, await opts.router(db));

  // Mirrors bootstrap()'s error handling, so a throwing handler shows up as a 500 with a body
  // rather than a hung socket that a test reports as a timeout.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };

  return {
    url: (path: string) => `http://localhost:${port}${path}`,
    db,
    setUser: (user) => { current = user; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close?.();
    },
  };
}
