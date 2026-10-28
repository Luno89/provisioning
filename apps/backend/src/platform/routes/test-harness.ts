import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import axios from 'axios';
import { testDatabase } from '../lib/test-database.js';
import type { Database } from '../lib/db-interface.js';
import { errorResponder } from '../middleware/async-route.js';
import { principalOf, type ClaimSettings } from '../lib/permissions.js';

export const TEST_USER = { id: 'test-user', email: 'test@example.com', isAdmin: false };

export interface HarnessOptions {
  router: (db: Database) => Router | Promise<Router>;
  prefix: string;
  user?: typeof TEST_USER | null;
  claims?: ClaimSettings | undefined;
}

export interface Harness {
  url: (path: string) => string;
  db: Database;
  setUser: (user: typeof TEST_USER | null) => void;
  close: () => Promise<void>;
}

export async function mountRouter(opts: HarnessOptions): Promise<Harness> {
  axios.defaults.proxy = false;
  const db = await testDatabase();

  let current: typeof TEST_USER | null = opts.user === undefined ? TEST_USER : opts.user;

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!current) return res.status(401).json({ error: 'Session missing' });
    (req as unknown as { user: typeof TEST_USER }).user = current;
    (req as unknown as { principal: ReturnType<typeof principalOf> }).principal = principalOf(current, opts.claims ?? { role: 'combined' });
    next();
  });

  app.use(opts.prefix, await opts.router(db));

  app.use(errorResponder);

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
