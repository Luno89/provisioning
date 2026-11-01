import express, { Router, type RequestHandler } from 'express';
import { itemsRouter } from './routes.js';

export type Mounts = { use(path: string, router: express.Router): unknown; get(path: string, handler: RequestHandler): unknown };

const guarded = (router: Router): Router => Router().use((_req, _res, next) => { next(); }, router);

export function wire(app: Mounts): void {
  app.use('/api/items', guarded(itemsRouter()));
  app.get('/install.sh', (_req, res) => { res.send('#!/bin/sh'); });
}

wire(express());
