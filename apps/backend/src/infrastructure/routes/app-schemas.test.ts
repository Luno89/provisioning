import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { appSchemasRouter } from './app-schemas.js';
import { APP_SETTINGS_SCHEMAS } from '../lib/app-schemas.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/app-schemas', router: () => router, user: PERSON });

describe('/api/app-schemas', () => {
  it('answers the settings schema of a known app type', async () => {
    const answer = await (await on(appSchemasRouter())).get('/api/app-schemas/palworld');
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual(APP_SETTINGS_SCHEMAS['palworld']);
  });

  it('answers 404 naming an app type it has no schema for', async () => {
    const answer = await (await on(appSchemasRouter())).get('/api/app-schemas/nothing-like-it');
    expect(answer.status).toBe(404);
    expect(answer.data).toEqual({ error: 'No settings schema for app type "nothing-like-it"' });
  });
});
