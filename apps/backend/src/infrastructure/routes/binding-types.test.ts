import { describe, expect, it } from 'vitest';
import axios from 'axios';
import { bindingTypesRouter } from './binding-types.js';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';

const ask = { validateStatus: () => true };
const postgres = { label: 'PostgreSQL', defaultPort: 5432, protocol: 'tcp' };

describe('/api/binding-types', () => {
  it('lets everyone read them and only an admin change them, since every deploy uses them', async () => {
    const person = await mountRouter({ prefix: '/api/binding-types', router: async (db) => bindingTypesRouter({ db: db.infrastructure }) });
    expect((await axios.get(person.url('/api/binding-types'), ask)).status).toBe(200);
    expect((await axios.put(person.url('/api/binding-types/postgres'), postgres, ask)).status).toBe(403);
    expect((await axios.delete(person.url('/api/binding-types/postgres'), ask)).status).toBe(403);
    await person.close();

    const admin = await mountRouter({ prefix: '/api/binding-types', user: { ...TEST_USER, isAdmin: true } as typeof TEST_USER, router: async (db) => bindingTypesRouter({ db: db.infrastructure }) });
    expect((await axios.put(admin.url('/api/binding-types/mydb'), postgres, ask)).status).toBe(200);
    expect((await axios.delete(admin.url('/api/binding-types/mydb'), ask)).status).toBeLessThan(300);
    await admin.close();
  });
});
