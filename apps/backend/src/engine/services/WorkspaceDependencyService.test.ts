import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDependency } from '@koala/agent-engine';
import { anyOf, arrayWith, objectWith } from '../../platform/lib/test-matchers.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';
import { WorkspaceDependencyService, type DependencyUse, type WorkspaceDependencyDeps } from './WorkspaceDependencyService.js';

const OWNER = 'u1';

const pdfTools = (over: Partial<WorkspaceDependency> = {}): WorkspaceDependency => ({
  name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }], ...over,
});

let db: Database;
let deps: WorkspaceDependencyDeps;
let changes: [string, string, DependencyUse][];
let service: WorkspaceDependencyService;

beforeEach(() => {
  db = memoryDatabase();
  changes = [];
  deps = {
    store: db.engine,
    tools: async () => [{ name: 'fetch_pdf', needs: ['pdf-tools'] } as never],
    servers: async () => [],
    changed: async (ownerId, name, use) => { changes.push([ownerId, name, use]); },
  };
  service = new WorkspaceDependencyService(deps);
});

describe('a person\'s workspace dependencies', () => {
  it('lists the shipped ones with their own, by name', async () => {
    const names = (await service.list(OWNER)).map((entry) => entry.name);
    expect(names).toEqual(arrayWith(['koala-e2e', 'jq', 'node', 'playwright']));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(await service.catalogue(OWNER)).toEqual(arrayWith([objectWith({ name: 'jq' })]));
  });

  it('adds one that holds together, saying which tool needs it', async () => {
    const saved = await service.save(OWNER, pdfTools());
    expect(saved).toMatchObject({ saved: true, dependency: { name: 'pdf-tools', mine: true, script: false, ownerId: OWNER, usedBy: { tools: ['fetch_pdf'] } } });
    expect((await service.list(OWNER)).find((entry) => entry.name === 'pdf-tools')).toMatchObject({ mine: true, usedBy: { tools: ['fetch_pdf'] } });
    expect((await service.list('u2')).some((entry) => entry.name === 'pdf-tools')).toBe(false);
  });

  it('refuses one that says nothing about how it installs, and one that takes a shipped name', async () => {
    expect(await service.save(OWNER, pdfTools({ install: [] }))).toEqual({ saved: false, problems: arrayWith(['pdf-tools has to say how it is installed']) });
    const taken = await service.save(OWNER, { name: 'jq', summary: 'mine', provides: ['jq'], install: [{ via: 'dnf', packages: ['jq'] }] });
    expect(taken.saved === false && taken.problems).toContain('jq is one Koala ships; pick another name for your own');
  });

  it('tells what changed with everything that needs it, the dependencies that need it included', async () => {
    await service.save(OWNER, pdfTools());
    await service.save(OWNER, { name: 'reader', summary: 'Reads.', provides: ['read'], needs: ['pdf-tools'], install: [{ via: 'dnf', packages: ['less'] }] });
    changes.length = 0;
    await service.save(OWNER, pdfTools({ summary: 'PDF tools, newer.' }));
    expect(changes).toEqual([[OWNER, 'pdf-tools', { tools: ['fetch_pdf'], servers: [], dependencies: ['reader'], steps: anyOf(Array), trees: [] }]]);
  });

  it('reports the MCP servers, steps and tree workspaces that need a dependency', async () => {
    const server: McpServerRecord = { id: 's1', ownerId: OWNER, name: 'pdf-server', runs: { where: 'workspace', needs: ['pdf-tools'], start: 'x', port: 1 }, createdAt: 't', updatedAt: 't' };
    const withUses = new WorkspaceDependencyService({
      ...deps,
      servers: async () => [server],
      steps: [{ title: 'Read PDF', needs: ['pdf-tools'] }, { title: 'Other' }],
      workspaces: async () => [{ treeId: 't2', treeName: 'Zed', file: { needs: ['pdf-tools'] } }, { treeId: 't1', file: { needs: ['pdf-tools'] } }, { treeId: 't3', file: {} }],
    });
    await withUses.save(OWNER, pdfTools());
    const view = (await withUses.list(OWNER)).find((entry) => entry.name === 'pdf-tools');
    expect(view?.usedBy).toEqual({ tools: ['fetch_pdf'], servers: ['pdf-server'], dependencies: [], steps: ['Read PDF'], trees: [{ id: 't1', name: 't1' }, { id: 't2', name: 'Zed' }] });
  });

  it('keeps one something still needs, and one Koala ships, and removes one nothing needs', async () => {
    await service.save(OWNER, pdfTools());
    expect(await service.remove(OWNER, 'pdf-tools')).toEqual({ removed: false, why: 'pdf-tools is still needed by the tool fetch_pdf' });
    expect(await service.remove(OWNER, 'koala-e2e')).toEqual({ removed: false, why: 'koala-e2e is one Koala ships' });
    expect(await service.remove(OWNER, 'nothing-here')).toEqual({ removed: false, why: 'you have no dependency called nothing-here' });

    await service.save(OWNER, pdfTools({ name: 'free', provides: ['free'] }));
    expect(await service.remove(OWNER, 'free')).toEqual({ removed: true });
    expect((await service.list(OWNER)).some((entry) => entry.name === 'free')).toBe(false);
  });

  it('lists what the dependencies it was given are, in place of the shipped ones, when told', async () => {
    const own = new WorkspaceDependencyService({ ...deps, shipped: [pdfTools({ name: 'only-one' })], tools: async () => [] });
    expect((await own.list(OWNER)).map((entry) => entry.name)).toEqual(['only-one']);
  });
});
