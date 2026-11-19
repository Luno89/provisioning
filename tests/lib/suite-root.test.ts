import { afterEach, describe, expect, it, vi } from 'vitest';
import { suiteRoot } from './suite-root.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('the root a VM suite starts', () => {
  it('keeps its records in a database of its own on the Mongo MONGO_URI names', () => {
    vi.stubEnv('MONGO_URI', 'mongodb://admin:secret@mongo.test:27017/provisioning?authSource=admin');
    const root = suiteRoot('mesh-live', 9474);
    expect(root.database).toMatch(/^koala_mesh_live_[a-z0-9]+$/);
    expect(root.mongoUri).toBe(`mongodb://admin:secret@mongo.test:27017/${root.database}?authSource=admin`);
    expect(root.env).toContain(`MONGO_URI=${root.mongoUri}`);
  });

  it('refuses to start without MONGO_URI rather than guessing a Mongo', () => {
    vi.stubEnv('MONGO_URI', '');
    expect(() => suiteRoot('mesh-live', 9474)).toThrow('mesh-live makes its root a database of its own beside MONGO_URI, which is not set');
  });
});
