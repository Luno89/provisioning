import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { ClientImportService, type ClientImportDeps } from './ClientImportService.js';
import type { SlotCluster } from '../../extensions/releases/slot-cluster.js';
import type { SlotAdapter } from '../../extensions/releases/adapter.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';

function setUp(over: { manifest?: unknown; established?: boolean; restore?: boolean; build?: boolean; pipeFails?: boolean; clientImport?: unknown } = {}) {
  const did: string[] = [];
  let received = '';
  const saved: Record<string, unknown>[] = [];
  const released: unknown[] = [];
  let project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: 'u1', targetClusterId: 'c1', appType: 'gitapp', giteaOwner: 'u1', giteaRepo: 'shop', releaseName: 'shop-1a2b3c', createdAt: 'x', ...(over.clientImport ? { clientImport: over.clientImport } : {}) } as ProjectMetadata;
  const cluster = {
    put: async (_t: unknown, manifest: { kind: string; metadata: { name: string }; spec?: { resources?: { requests: { storage: string } } } }) => { did.push(`put ${manifest.kind} ${manifest.metadata.name}${manifest.spec?.resources ? ` ${manifest.spec.resources.requests.storage}` : ''}`); },
    running: async (_t: unknown, pod: string) => { did.push(`running ${pod}`); },
    pipe: async (_t: unknown, pod: string, command: string[], input: NodeJS.ReadableStream) => {
      if (over.pipeFails) throw new Error('the connection dropped');
      for await (const chunk of input) received += String(chunk);
      did.push(`pipe ${pod} ${command.at(-1)}`);
      return '';
    },
    exec: async (_t: unknown, pod: string, command: string[]) => {
      did.push(`exec ${pod} ${command.join(' ')}`);
      return command[0] === 'unzip' ? JSON.stringify(over.manifest ?? { major_version: '20.0', modules: { sale: '20.0.1.0', base: '20.0.1.3' } }) : '';
    },
    remove: async (_t: unknown, kind: string, name: string) => { did.push(`remove ${kind} ${name}`); },
  } as unknown as SlotCluster;
  const deps: ClientImportDeps = {
    projects: async () => [project, { ...project, id: 'p2', ownerId: 'u2' }],
    saveProject: async (patch) => { saved.push(patch); project = { ...project, ...patch }; },
    clusterById: async () => ({ id: 'c1', name: 'system', provider: 'k3d' }) as never,
    adapterOf: async () => ({ id: 'odoo', ...(over.restore === false ? {} : { restore: async () => undefined }) }) as unknown as SlotAdapter,
    cluster,
    odooVersion: async () => '20.0',
    latestBuild: async () => (over.build === false ? undefined : { id: 'run-1', projectId: 'p1', status: 'succeeded', imageTag: 'reg/shop:one', commitSha: 'one', startedAt: '1' } as never),
    releases: {
      established: async () => (over.established ? { commit: 'abcdef1234', state: 'live' } as never : undefined),
      nameRelease: async (entry) => entry,
      release: async (entry, run) => { released.push([(entry.clientImport as { state: string } | undefined)?.state, run.id]); },
    },
    now: () => 'now',
  };
  return { service: new ClientImportService(deps), did, saved, released, received: () => received, project: () => project };
}

const body = () => Readable.from(['PK', 'zip-bytes']);

describe('starting a project from a client\'s database', () => {
  it('streams the backup into the release\'s namespace, checks its version, records it and releases the newest build with it', async () => {
    const { service, did, released, received, project } = setUp();
    expect(await service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).toEqual({ ok: true, value: { state: 'uploaded', mode: 'copy', bytes: 11, version: '20.0', modules: ['base', 'sale'], at: 'now' } });
    expect(received()).toBe('PKzip-bytes');
    expect(did).toEqual([
      'remove pod shop-1a2b3c-import-holder',
      'remove job shop-1a2b3c-restore-a',
      'remove pvc shop-1a2b3c-import',
      'put PersistentVolumeClaim shop-1a2b3c-import 2Gi',
      'put Pod shop-1a2b3c-import-holder',
      'running shop-1a2b3c-import-holder',
      'pipe shop-1a2b3c-import-holder cat > /import/backup.zip.part && mv /import/backup.zip.part /import/backup.zip',
      'exec shop-1a2b3c-import-holder unzip -p /import/backup.zip manifest.json',
      'remove pod shop-1a2b3c-import-holder',
    ]);
    expect(released).toEqual([['uploaded', 'run-1']]);
    expect(project().clientImport).toMatchObject({ state: 'uploaded' });
  });

  it('refuses another version, throws the upload away and says why', async () => {
    const { service, did, released, project } = setUp({ manifest: { major_version: '17.0', modules: {} } });
    expect(await service.upload('u1', 'p1', { mode: 'live', bytes: 11, body: body() })).toEqual({ ok: false, status: 409, error: 'the backup is from Odoo 17.0, and this project runs Odoo 20.0; moving a database from one Odoo version to another is a step of its own' });
    expect(did).toContain('exec shop-1a2b3c-import-holder rm -f /import/backup.zip /import/backup.zip.part');
    expect(did.at(-1)).toBe('remove pod shop-1a2b3c-import-holder');
    expect(project().clientImport).toMatchObject({ state: 'refused', version: '17.0', mode: 'live' });
    expect(released).toEqual([]);
  });

  it('waits for the first build when there is none', async () => {
    const { service, released } = setUp({ build: false });
    expect((await service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).ok).toBe(true);
    expect(released).toEqual([]);
  });

  it('records an upload that broke, and still lets the holder go', async () => {
    const { service, did, project } = setUp({ pipeFails: true });
    expect(await service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).toEqual({ ok: false, status: 500, error: 'the backup could not be taken in: the connection dropped' });
    expect(project().clientImport).toMatchObject({ state: 'failed' });
    expect(did.at(-1)).toBe('remove pod shop-1a2b3c-import-holder');
  });

  it('only starts a project: not once it has released, not twice at once, not for an app that cannot, and not someone else\'s', async () => {
    expect(await setUp({ established: true }).service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).toEqual({ ok: false, status: 409, error: 'Shop has already released (abcdef12 is live); a client\'s database can only start a project' });
    expect(await setUp({ clientImport: { state: 'importing', mode: 'copy', bytes: 1, at: 'x' } }).service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).toMatchObject({ status: 409, error: 'the client\'s database is already being imported' });
    expect(await setUp({ restore: false }).service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).toMatchObject({ status: 409 });
    expect(await setUp().service.upload('u1', 'p2', { mode: 'copy', bytes: 11, body: body() })).toMatchObject({ status: 404 });
    expect(await setUp().service.upload('u1', 'p1', { mode: 'other', bytes: 11, body: body() })).toMatchObject({ status: 400 });
    expect(await setUp().service.upload('u1', 'p1', { mode: 'copy', bytes: Number.NaN, body: body() })).toMatchObject({ status: 411 });
    expect(await setUp({ established: true }).service.view('u1', 'p1')).toEqual({ ok: true, value: { open: false, why: 'Shop has already released (abcdef12 is live); a client\'s database can only start a project' } });
  });

  it('starts without the client\'s database: the import is set aside and the newest build released fresh', async () => {
    const { service, did, released, project } = setUp({ clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 'x' } });
    expect(await service.startFresh('u1', 'p1')).toEqual({ ok: true, value: { released: true } });
    expect(project().clientImport).toBeNull();
    expect(did).toContain('remove pvc shop-1a2b3c-import');
    expect(released).toEqual([[undefined, 'run-1']].map(([state, id]) => [state, id]));
    expect(await setUp().service.startFresh('u1', 'p1')).toEqual({ ok: false, status: 409, error: 'Shop is not waiting for a client\'s database' });
    expect(await setUp({ established: true, clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 'x' } }).service.startFresh('u1', 'p1')).toEqual({ ok: false, status: 409, error: 'Shop has already released' });
  });

  it('takes an upload for a project that awaits one', async () => {
    expect((await setUp({ clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 'x' } }).service.upload('u1', 'p1', { mode: 'copy', bytes: 11, body: body() })).ok).toBe(true);
  });
});
