import { describe, expect, it } from 'vitest';
import { appSchemasRouter } from './app-schemas.js';
import { APP_SETTINGS_SCHEMAS } from '../lib/app-schemas.js';
import { callRouter } from '../testing/call-router.js';

describe('/api/app-schemas', () => {
  it('answers the settings schema of a known app type', async () => {
    const answer = await callRouter(appSchemasRouter(), '/api/app-schemas', { path: '/palworld' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(APP_SETTINGS_SCHEMAS['palworld']);
  });

  it('answers 404 naming an app type it has no schema for', async () => {
    const answer = await callRouter(appSchemasRouter(), '/api/app-schemas', { path: '/nothing-like-it' });
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: 'No settings schema for app type "nothing-like-it"' });
  });
});
