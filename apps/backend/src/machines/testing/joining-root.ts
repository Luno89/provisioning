import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Database } from '../../platform/lib/db-interface.js';
import { rootAuthOver, type RootAuthWorld } from '../../platform/testing/root-auth.js';
import { openRoutesOf } from '../../open-routes.js';

export interface JoiningRoot {
  app: express.Express;
  url: string;
  root: RootAuthWorld;
}

export async function joiningRoot(db: Database, closers: Array<() => Promise<void> | void>): Promise<JoiningRoot> {
  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = rootAuthOver(db, { publicUrl: url, open: openRoutesOf('root') });
  root.mount(app);
  return { app, url, root };
}
