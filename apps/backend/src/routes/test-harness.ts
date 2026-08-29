import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import axios from 'axios';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';

export const TEST_USER = { id: 'test-user', email: 'test@example.com', isAdmin: false };

export interface HarnessOptions {
  router: (db: Database) => Router | Promise<Router>;
  prefix: string;
  user?: typeof TEST_USER | null;
}

export interface Harness {
  url: (path: string) => string;
  db: Database;
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

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!current) return res.status(401).json({ error: 'Session missing' });
    (req as unknown as { user: typeof TEST_USER }).user = current;
    next();
  });

  app.use(opts.prefix, await opts.router(db));

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
