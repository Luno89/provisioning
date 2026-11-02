import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { bindingTypesRouter, validateBindingType } from './binding-types.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/binding-types', router: () => router, user: PERSON });

const postgres = { label: 'PostgreSQL', defaultPort: 5432, protocol: 'tcp' };

describe('validateBindingType', () => {
  it('accepts a binding type with a name, a label, a valid port and a known protocol', () => {
    expect(validateBindingType({ id: 'my_db-1', label: 'My DB', defaultPort: 5432, protocol: 'tcp' })).toBeNull();
  });

  it('says what is wrong with a binding type that is not one', () => {
    expect(validateBindingType(null)).toBe('Binding type must be an object');
    expect(validateBindingType({ id: 'has space', label: 'x' })).toMatch(/^id must be a non-empty alphanumeric string/);
    expect(validateBindingType({ id: 'a' })).toBe('label must be a non-empty string');
    expect(validateBindingType({ id: 'a', label: 'A', defaultPort: 70000 })).toBe('defaultPort must be a valid TCP port number (1-65535)');
    expect(validateBindingType({ id: 'a', label: 'A', protocol: 'smtp' })).toBe('protocol must be one of http, https, tcp, grpc');
  });
});

describe('/api/binding-types', () => {
  it('lets everyone read them, seeding the built-in ones first', async () => {
    const db = memoryDatabase();
    const answer = await (await on(bindingTypesRouter({ db: db.infrastructure }))).get('/api/binding-types');
    expect(answer.status).toBe(200);
    expect((answer.data as { id: string }[]).map((type) => type.id)).toContain('mongodb');
  });

  it('refuses a person who is not the operator the right to change them, since every deploy uses them', async () => {
    const router = bindingTypesRouter({ db: memoryDatabase().infrastructure });
    expect((await (await on(router)).put('/api/binding-types/postgres', postgres)).status).toBe(403);
    expect((await (await on(router)).delete('/api/binding-types/postgres')).status).toBe(403);
  });

  it('saves a valid binding type under the id in the address for the operator, and removes it', async () => {
    const db = memoryDatabase();
    const router = bindingTypesRouter(db.infrastructure);
    const saved = await (await on(router)).put('/api/binding-types/mydb', postgres, { user: OPERATOR });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ ok: true, bindingType: { ...postgres, id: 'mydb' } });
    expect((await db.infrastructure.getBindingTypes()).map((type) => type.id)).toContain('mydb');
    expect((await (await on(router)).delete('/api/binding-types/mydb', { user: OPERATOR })).data).toEqual({ ok: true });
    expect((await db.infrastructure.getBindingTypes()).map((type) => type.id)).not.toContain('mydb');
  });

  it('refuses an invalid binding type with the reason', async () => {
    const router = bindingTypesRouter({ db: memoryDatabase().infrastructure });
    const answer = await (await on(router)).put('/api/binding-types/mydb', { ...postgres, defaultPort: 0 }, { user: OPERATOR });
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'defaultPort must be a valid TCP port number (1-65535)' });
  });
});
