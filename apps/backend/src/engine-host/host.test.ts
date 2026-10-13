import { describe, expect, it } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { INSTALLED_EXTENSIONS } from '../extensions/installed.js';
import { createEngineHost, storesFromDatabase } from './host.js';

describe('the engine host', () => {
  it('has a handler for every tool grove and workspace offer through their runtimes, so none is granted with nothing behind it', () => {
    const db = new MemoryDB();
    const host = createEngineHost({
      models: {} as never,
      stores: storesFromDatabase(db),
      publishedWorkspaces: { get: async () => undefined, save: async () => undefined },
      readRepoFile: async () => undefined,
      writeRepoFile: async () => ({ changed: false }),
      workspaceBuild: async () => ({ started: false, reason: 'running' }),
    });
    const offered = INSTALLED_EXTENSIONS.filter((extension) => extension.id !== 'platform').flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    expect(offered).toEqual(expect.arrayContaining(['change_workspace', 'mark_waiting', 'propose_plan']));
    expect(offered.filter((name) => !host.implemented.has(name))).toEqual([]);
  });
});
