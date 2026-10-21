import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from './test-harness.js';
import { workspaceDependenciesRouter } from './workspace-dependencies.js';
import { WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';

const quiet = { validateStatus: () => true };

describe('a person\'s workspace dependencies', () => {
  it('lists the shipped ones with their own, adds one that holds together, and keeps one something still needs', async () => {
    const h = await mountRouter({
      prefix: '/api/workspace-dependencies',
      router: (db) => workspaceDependenciesRouter({
        dependencies: new WorkspaceDependencyService({
          store: db,
          tools: async () => [{ name: 'fetch_pdf', needs: ['pdf-tools'] } as never],
          servers: async () => [],
        }),
      }),
    });
    const list = async () => (await axios.get(h.url('/api/workspace-dependencies'))).data.dependencies as { name: string; mine: boolean; usedBy: { tools: string[] } }[];
    expect((await list()).map((entry) => entry.name)).toEqual(expect.arrayContaining(['koala-e2e', 'jq', 'node', 'playwright']));

    const bad = await axios.put(h.url('/api/workspace-dependencies/pdf-tools'), { name: 'pdf-tools', summary: 'PDF tools.', provides: [], install: [] }, quiet);
    expect(bad.status).toBe(400);
    expect(bad.data.problems).toContain('pdf-tools has to say how it is installed');
    expect((await axios.put(h.url('/api/workspace-dependencies/jq'), { name: 'jq', summary: 'mine', provides: ['jq'], install: [{ via: 'dnf', packages: ['jq'] }] }, quiet)).data.problems).toContain('jq is one Koala ships; pick another name for your own');

    const good = await axios.put(h.url('/api/workspace-dependencies/pdf-tools'), { name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }] }, quiet);
    expect(good.status).toBe(200);
    expect(good.data.dependency).toMatchObject({ name: 'pdf-tools', mine: true, script: false, usedBy: { tools: ['fetch_pdf'] }, ownerId: TEST_USER.id });
    expect((await list()).find((entry) => entry.name === 'pdf-tools')).toMatchObject({ mine: true, usedBy: { tools: ['fetch_pdf'] } });

    const kept = await axios.delete(h.url('/api/workspace-dependencies/pdf-tools'), quiet);
    expect([kept.status, kept.data.error]).toEqual([409, 'pdf-tools is still needed by the tool fetch_pdf']);
    expect((await axios.delete(h.url('/api/workspace-dependencies/koala-e2e'), quiet)).data.error).toBe('koala-e2e is one Koala ships');
    await h.close();
  });
});
