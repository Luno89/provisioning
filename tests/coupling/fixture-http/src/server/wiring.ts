import express, { Router, type RequestHandler } from 'express';
import { itemsRouter } from './routes.js';
import { sessionsRouter, stepsRouter } from './sessions.js';

export type Mounts = { use(path: string, router: express.Router): unknown; get(path: string, handler: RequestHandler): unknown };

const guarded = (router: Router): Router => Router().use((_req, _res, next) => { next(); }, router);

export function wire(app: Mounts): void {
  app.use('/api/items', guarded(itemsRouter()));
  app.get('/install.sh', (_req, res) => { res.send('#!/bin/sh'); });
}

export function wireSessions(deps: { app: Mounts; steps?: Router | undefined }): void {
  if (deps.steps) deps.app.use('/sessions', sessionsRouter({ steps: deps.steps }));
}

wire(express());

const steps = process.env.SESSIONS ? stepsRouter() : undefined;
wireSessions({ app: express(), steps });
