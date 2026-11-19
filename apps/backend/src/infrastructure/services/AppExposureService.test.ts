import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { ClusterUnreachable } from './ClusterAccess.js';
import { AppExposureService, type ExposureClusters, type InstanceEdge } from './AppExposureService.js';
import type { Server as SocketServer } from 'socket.io';

const WEB = JSON.stringify({ items: [{ metadata: { name: 'shop-live' }, spec: { ports: [{ port: 8069 }] } }] });
const TRAEFIK = JSON.stringify({ spec: { ports: [{ name: 'web', port: 80, nodePort: 31080 }] } });
const KOALA = 'machine-dev1';
const DESK = 'machine-desk';

const app = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata =>
  ({ id: 'd1abcdef', name: 'Shop', clusterId: KOALA, namespace: 'shop-d1abcd', strategy: 'helm', status: 'running', ...over }) as DeploymentMetadata;

const desk: ClusterMetadata = { id: DESK, name: 'desk', provider: 'machine', status: 'healthy', meshIp: '100.64.0.7', machineId: 'desk' } as ClusterMetadata;

function edgeOn(sites: string, over: Partial<InstanceEdge> = {}): InstanceEdge & { reloads: number } {
  const edge = { name: 'luno', localPort: 8000, sites, reloads: 0, nestedReady: () => false, async reload() { edge.reloads += 1; }, ...over };
  return edge;
}

async function setUp(deployments: DeploymentMetadata[], options: { edge?: Partial<InstanceEdge> | 'none'; traefikIn?: 'traefik' | 'kube-system'; groups?: Map<string, string>; told?: string[] } = {}) {
  const store = new MemoryInfrastructureStore();
  for (const dep of deployments) await store.saveDeployment(dep);
  await store.saveCluster(desk);
  const access = mock<ExposureClusters['access']>();
  access.reach.mockImplementation(async (clusterId) => {
    if (clusterId === KOALA) return { clusterId, kind: 'koala' };
    if (clusterId === DESK) return { clusterId, kind: 'machine', kubeconfig: 'apiVersion: v1' };
    throw new ClusterUnreachable(clusterId, 'stopped', `${clusterId} is stopped until something runs on it`);
  });
  access.kubectl.mockImplementation(async (_target, args) => {
    if (args[1] === 'svc' && args[2] === 'traefik') return args[4] === (options.traefikIn ?? 'kube-system') ? TRAEFIK : '';
    if (args[1] === 'svc') return WEB;
    throw new Error(`no answer for kubectl ${args.join(' ')}`);
  });
  const sites = mkdtempSync(join(tmpdir(), 'koala-edge-sites-'));
  const edge = options.edge === 'none' ? undefined : edgeOn(sites, options.edge);
  const groups = options.groups ?? new Map<string, string>();
  const told = options.told;
  const io = told ? { to: (room: string) => ({ emit: (event: string) => { told.push(`${room} ${event}`); return true; } }) } as unknown as SocketServer : undefined;
  const service = new AppExposureService({ infrastructure: store }, { access, getByIdUnscoped: async (id) => (await store.getClusters()).find((c) => c.id === id) }, io, {
    edge,
    groupOf: async (dep) => (dep.gitappProjectId ? groups.get(dep.gitappProjectId) : undefined),
    domain: () => domain,
  });
  const site = (file: string): string => readFileSync(join(sites, file), 'utf8');
  const files = (): string[] => readdirSync(sites).sort();
  const stored = async (id = 'd1abcdef') => (await store.getDeployments()).find((d) => d.id === id)!;
  return { service, edge, site, files, sites, stored, access };
}

let domain: string | undefined;
beforeEach(() => { domain = undefined; });
afterEach(() => { domain = undefined; });

describe('exposing an app on this computer, through the instance\'s edge', () => {
  it('serves it at <app>.localhost on the edge\'s local port, through Traefik on Koala\'s own cluster by its service name, and reloads the edge', async () => {
    const { service, edge, site, files } = await setUp([app()]);
    const exposed = await service.exposeLocal('d1abcdef');
    expect(exposed).toMatchObject({ isExposedLocally: true, isExposed: true, localExposureUrl: 'http://shop.localhost:8000', exposureUrl: 'http://shop.localhost:8000' });
    expect(files()).toEqual(['shop-d1abcd.local.caddy']);
    expect(site('shop-d1abcd.local.caddy')).toMatch(/^http:\/\/shop\.localhost:8000 \{/);
    expect(site('shop-d1abcd.local.caddy')).toContain('reverse_proxy traefik.kube-system.svc.cluster.local:80');
    expect(site('shop-d1abcd.local.caddy')).toContain('header_up Host shop-d1abcd.apps.local');
    expect(site('shop-d1abcd.local.caddy')).toContain('header_up X-Forwarded-Proto http\n');
    expect(edge?.reloads).toBe(1);
  });

  it('keeps the address an app already had, so a saved link keeps working', async () => {
    const { service, site } = await setUp([app({ localExposureUrl: 'http://tabbyapi-production.localhost:8000' })]);
    expect((await service.exposeLocal('d1abcdef')).localExposureUrl).toBe('http://tabbyapi-production.localhost:8000');
    expect(site('shop-d1abcd.local.caddy')).toMatch(/^http:\/\/tabbyapi-production\.localhost:8000 \{/);
  });

  it('gives a second app of the same name an address of its own', async () => {
    const other = app({ id: 'other', name: 'shop', namespace: 'shop-other0', isExposedLocally: true, localExposureUrl: 'http://shop.localhost:8000' });
    const { service } = await setUp([app(), other]);
    expect((await service.exposeLocal('d1abcdef')).localExposureUrl).toBe('http://shop-2.localhost:8000');
  });

  it('reaches an app on another of the person\'s machines at its mesh address and Traefik\'s node port', async () => {
    const { service, site } = await setUp([app({ clusterId: DESK })], { traefikIn: 'traefik' });
    await service.exposeLocal('d1abcdef');
    expect(site('shop-d1abcd.local.caddy')).toContain('reverse_proxy 100.64.0.7:31080');
  });

  it('refuses, saying why, an app on a stopped machine, with no web service, or on a cluster without Traefik, writing nothing', async () => {
    const stopped = await setUp([app({ clusterId: 'machine-off' })]);
    await expect(stopped.service.exposeLocal('d1abcdef')).rejects.toThrow('machine-off is stopped until something runs on it');
    expect(stopped.files()).toEqual([]);

    const databaseOnly = await setUp([app()]);
    databaseOnly.access.kubectl.mockImplementation(async (_t, args) => (args[2] === 'traefik' ? TRAEFIK : JSON.stringify({ items: [{ metadata: { name: 'shop-d1abcd-postgres' }, spec: { ports: [{ port: 5432 }] } }] })));
    await expect(databaseOnly.service.exposeLocal('d1abcdef')).rejects.toThrow('No proxyable web services found in namespace "shop-d1abcd"');

    const noTraefik = await setUp([app()]);
    noTraefik.access.kubectl.mockImplementation(async (_t, args) => (args[2] === 'traefik' ? '' : WEB));
    await expect(noTraefik.service.exposeLocal('d1abcdef')).rejects.toThrow(`${KOALA} has no Traefik`);
    expect(noTraefik.files()).toEqual([]);
  });

  it('refuses on Koala\'s servers, where there is no computer of the person\'s to answer on, and where there is no edge at all', async () => {
    const pool = await setUp([app()], { edge: { localPort: undefined } });
    await expect(pool.service.exposeLocal('d1abcdef')).rejects.toThrow('This instance runs on Koala\'s servers');
    const none = await setUp([app()], { edge: 'none' });
    await expect(none.service.exposeLocal('d1abcdef')).rejects.toThrow('this Koala has none');
  });

  it('takes the site away again, leaving a public address alone', async () => {
    domain = 'koala.dev';
    const { service, files, stored } = await setUp([app()]);
    await service.exposeLocal('d1abcdef');
    await service.exposePublic('d1abcdef');
    const hidden = await service.unexposeLocal('d1abcdef');
    expect(hidden).toMatchObject({ isExposedLocally: false, isExposed: true, exposureUrl: 'https://shop-luno.koala.dev' });
    expect(hidden.localExposureUrl).toBeUndefined();
    expect(files()).toEqual(['shop-d1abcd.public.caddy']);
    expect((await stored()).localExposureUrl).toBeUndefined();
  });
});

describe('exposing an app publicly, at an address root routes to the edge', () => {
  it('refuses without a domain of the instance\'s own, saying it can still be exposed on this computer', async () => {
    const { service, files } = await setUp([app()]);
    await expect(service.exposePublic('d1abcdef')).rejects.toThrow('It can still be exposed on this computer');
    expect(files()).toEqual([]);
  });

  it('gives an app a flat address under the instance\'s name, free among its other apps, over plain http to the edge', async () => {
    domain = 'koala.dev';
    const taken = app({ id: 'other', name: 'shop!', publicHostname: 'shop-luno.koala.dev' });
    const { service, site, edge } = await setUp([app(), taken]);
    expect(await service.exposePublic('d1abcdef')).toMatchObject({ publicHostname: 'shop-2-luno.koala.dev', publicExposureUrl: 'https://shop-2-luno.koala.dev' });
    expect(site('shop-d1abcd.public.caddy')).toMatch(/^http:\/\/shop-2-luno\.koala\.dev \{/);
    expect(site('shop-d1abcd.public.caddy')).toContain('header_up X-Forwarded-Proto https');
    expect(edge?.reloads).toBe(1);
  });

  it('shows the nested address once root says it is ready, the flat one still answering', async () => {
    domain = 'koala.dev';
    const { service, site } = await setUp([app({ publicHostname: 'shop-luno.koala.dev' })], { edge: { nestedReady: () => true } });
    expect(await service.exposePublic('d1abcdef')).toMatchObject({ publicHostname: 'shop-luno.koala.dev', publicExposureUrl: 'https://shop.luno.koala.dev' });
    expect(site('shop-d1abcd.public.caddy')).toMatch(/^http:\/\/shop-luno\.koala\.dev, http:\/\/shop\.luno\.koala\.dev \{/);
  });

  it('addresses a shared project\'s app under its group, never nested, and moves it back once the project is taken back', async () => {
    domain = 'koala.dev';
    const groups = new Map([['p1', 'acme']]);
    const { service, stored } = await setUp([app({ gitappProjectId: 'p1', isExposedPublicly: true, publicHostname: 'shop-luno.koala.dev' })], { edge: { nestedReady: () => true }, groups });
    await service.syncExposedApps();
    expect(await stored()).toMatchObject({ publicHostname: 'shop-acme.koala.dev', publicExposureUrl: 'https://shop-acme.koala.dev' });
    groups.clear();
    await service.syncExposedApps();
    expect(await stored()).toMatchObject({ publicHostname: 'shop-luno.koala.dev', publicExposureUrl: 'https://shop.luno.koala.dev' });
  });
});

describe('the path an app\'s link opens at', () => {
  it('keeps the path the person sets, starting it with a slash, and tells their other pages', async () => {
    const told: string[] = [];
    const { service, stored } = await setUp([app({ ownerId: 'bo' })], { told });
    expect(await service.updateExposurePath('d1abcdef', ' admin ')).toMatchObject({ exposurePath: '/admin' });
    expect((await stored()).exposurePath).toBe('/admin');
    expect(await service.updateExposurePath('d1abcdef', '/web/login')).toMatchObject({ exposurePath: '/web/login' });
    expect(await service.updateExposurePath('d1abcdef', '  ')).toMatchObject({ exposurePath: '' });
    expect(told).toEqual(['user:bo deployment-updated', 'user:bo deployment-updated', 'user:bo deployment-updated']);
  });
});

describe('an Odoo project\'s preview', () => {
  const odoo = () => app({ appType: 'odoo-project' });

  it('is served beside the app, on this computer and publicly, and taken away with it', async () => {
    domain = 'koala.dev';
    const { service, files, site } = await setUp([odoo()]);
    expect(await service.exposeLocal('d1abcdef')).toMatchObject({ localExposureUrl: 'http://shop.localhost:8000', previewLocalUrl: 'http://shop-preview.localhost:8000' });
    expect(site('shop-d1abcd-preview.local.caddy')).toContain('header_up Host shop-d1abcd-preview.apps.local');
    expect(await service.exposePublic('d1abcdef')).toMatchObject({ previewPublicUrl: 'https://shop-preview-luno.koala.dev' });
    expect(files()).toEqual(['shop-d1abcd-preview.local.caddy', 'shop-d1abcd-preview.public.caddy', 'shop-d1abcd.local.caddy', 'shop-d1abcd.public.caddy']);
    await service.unexposeLocal('d1abcdef');
    expect((await service.unexposePublic('d1abcdef')).previewPublicUrl).toBeUndefined();
    expect(files()).toEqual([]);
  });

  it('is nothing for an app that is not an Odoo project', async () => {
    const { service, files } = await setUp([app()]);
    expect((await service.exposeLocal('d1abcdef')).previewLocalUrl).toBeUndefined();
    expect(files()).toEqual(['shop-d1abcd.local.caddy']);
  });
});

describe('publishing every exposed app again, as the backend starts', () => {
  it('writes each exposed app\'s sites, removes every other site, and reloads the edge once', async () => {
    const { service, files, sites, edge } = await setUp([app({ isExposedLocally: true, localExposureUrl: 'http://tabbyapi-production.localhost:8000' }), app({ id: 'quiet', name: 'quiet', namespace: 'quiet-0' })]);
    writeFileSync(join(sites, 'gone-123456.local.caddy'), 'old');
    writeFileSync(join(sites, 'shop-d1abcd.caddy'), 'from before local and public had files of their own');
    await service.syncExposedApps();
    expect(files()).toEqual(['shop-d1abcd.local.caddy']);
    expect(edge?.reloads).toBe(1);
  });

  it('keeps the site of an app whose cluster cannot be read as it was, and says which', async () => {
    const { service, files, sites } = await setUp([app({ clusterId: 'machine-off', isExposedLocally: true, localExposureUrl: 'http://shop.localhost:8000' })]);
    writeFileSync(join(sites, 'shop-d1abcd.local.caddy'), 'as it was');
    await expect(service.syncExposedApps()).rejects.toThrow('Shop: machine-off is stopped until something runs on it');
    expect(files()).toEqual(['shop-d1abcd.local.caddy']);
  });

  it('says which apps answer nowhere on a Koala with no edge, and is quiet when none is exposed', async () => {
    await expect((await setUp([app({ isExposedLocally: true })], { edge: 'none' })).service.syncExposedApps()).rejects.toThrow('answer nowhere: Shop');
    await expect((await setUp([app()], { edge: 'none' })).service.syncExposedApps()).resolves.toBeUndefined();
  });

  it('says the edge refused its sites when it did', async () => {
    const { service } = await setUp([app()], { edge: { reload: async () => { throw new Error('the edge refused its config (400): adapting'); } } });
    await expect(service.exposeLocal('d1abcdef')).rejects.toThrow('The edge did not take its new sites: the edge refused its config (400): adapting');
  });
});
