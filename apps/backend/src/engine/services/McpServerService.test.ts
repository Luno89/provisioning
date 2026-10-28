import { describe, expect, it } from 'vitest';
import { McpServerService } from './McpServerService.js';
import { runsFingerprint, serverNameFrom, type McpServerRecord } from '../lib/mcp-servers.js';
import { MCP_SERVER_TEMPLATES } from '../../extensions/mcp/templates.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';
import type { StartRunRequest } from '../../engine-host/registries/run-starter.js';

function world(over: { deployments?: Partial<DeploymentMetadata>[]; startFails?: string; finished?: Record<string, { outcome: string; reason?: string }>; projects?: { id: string; name: string }[] } = {}) {
  const records = new Map<string, McpServerRecord>();
  const grants: string[] = [];
  const started: StartRunRequest[] = [];
  let ids = 0;
  let clock = Date.parse('2026-10-12T12:00:00Z');
  const deployments = (over.deployments ?? []).map((entry) => ({ id: 'd1', name: 'weather-api', ownerId: 'u1', status: 'running', appType: 'gitapp', ...entry }) as DeploymentMetadata);
  const service = new McpServerService({
    store: {
      list: async (ownerId) => [...records.values()].filter((server) => server.ownerId === ownerId),
      save: async (server) => { records.set(server.id, structuredClone(server)); },
      remove: async (_ownerId, id) => { records.delete(id); },
    },
    templates: () => MCP_SERVER_TEMPLATES,
    runs: { start: async (request) => { if (over.startFails) throw new Error(over.startFails); started.push(request); return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'capture-mcp-server' }; } },
    finished: async (runId) => over.finished?.[runId],
    deployments: async () => deployments,
    names: async () => ({ treeName: 'Weather API' }),
    projects: async () => over.projects ?? [],
    grants: { renameServer: async (_ownerId, from, to) => { grants.push(`${from}->${to}`); return 1; }, forgetServer: async (_ownerId, name) => { grants.push(`-${name}`); return 1; } },
    now: () => new Date((clock += 1000)),
    newId: () => `s${(ids += 1)}`,
  });
  return { service, records, started, grants };
}

describe('the MCP server catalogue', () => {
  it('attaches a server to the person\'s own projects, named in its view, and to no one else\'s', async () => {
    const { service } = world({ projects: [{ id: 'p1', name: 'Shop' }] });
    const added = await service.add('u1', { template: 'playwright', projects: ['p1'] });
    expect(added).toMatchObject({ ok: true, server: { projects: ['p1'], projectsNamed: [{ id: 'p1', name: 'Shop' }] } });
    expect(await service.save('u1', 's1', { projects: ['p1', 'p9'] })).toMatchObject({ ok: false, status: 400, error: 'that project is not one of yours' });
    expect(await service.save('u1', 's1', { projects: 'p1' })).toMatchObject({ ok: false, status: 400, error: 'projects has to be a list of project ids' });
    expect(await service.save('u1', 's1', { projects: [] })).toMatchObject({ ok: true, server: { projects: [] } });
    expect((await service.get('u1', 's1'))?.projectsNamed).toBeUndefined();
  });

  it('adds a known server as a copy the person can change, and starts capturing it', async () => {
    const { service, records, started } = world();
    const added = await service.add('u1', { template: 'playwright' });
    expect(added).toMatchObject({ ok: true, server: { name: 'playwright', from: { template: 'playwright' }, omit: ['browser_take_screenshot', 'browser_run_code_unsafe'], status: { state: 'capturing' } } });
    expect(started).toEqual([expect.objectContaining({ agentSlug: 'mcp-capture', inputs: { serverId: 's1' }, runId: expect.stringMatching(/^mcp-capture-s1-/) })]);
    expect(records.get('s1')!.capturing!.runId).toBe(started[0]!.runId);
    expect((await service.add('u1', { template: 'playwright' }))).toMatchObject({ ok: true, server: { name: 'playwright-2' } });
    expect((await service.catalogue('u1')).templates).toEqual([expect.objectContaining({ id: 'playwright', added: true })]);
  });

  it('adds a known server with the notes, dependency and tools it is given in place of the template\'s own', async () => {
    const { service } = world();
    const added = await service.add('u1', { template: 'playwright', notes: 'Odoo runs at http://localhost:8069.', dependsOn: 'the kept Odoo', offer: ['browser_navigate', 'browser_snapshot'] });
    expect(added).toMatchObject({ ok: true, server: { notes: 'Odoo runs at http://localhost:8069.', dependsOn: 'the kept Odoo', offer: ['browser_navigate', 'browser_snapshot'] } });
    expect(added.ok && added.server.omit).toBeUndefined();
  });

  it('adds a custom one from a URL, and refuses one that makes no sense, a name taken, or a template there is not', async () => {
    const { service } = world();
    expect(await service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' }, notes: '  Search before you read.  ' })).toMatchObject({ ok: true, server: { name: 'docs', notes: 'Search before you read.' } });
    expect(await service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://other.test/mcp' } })).toMatchObject({ ok: false, status: 409 });
    expect(await service.add('u1', { name: 'x', runs: { where: 'hosted' } })).toMatchObject({ ok: false, status: 400 });
    expect(await service.add('u1', { template: 'nope' })).toMatchObject({ ok: false, status: 404 });
  });

  it('captures again when how it runs changes, and not for notes', async () => {
    const { service, started } = world();
    await service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' } });
    await service.save('u1', 's1', { notes: 'Read the index first.', tools: { search: { note: 'Quote phrases.', kind: 'read-only' } } });
    expect(started).toHaveLength(1);
    const moved = await service.save('u1', 's1', { runs: { where: 'hosted', url: 'http://docs2.test/mcp' } });
    expect(started).toHaveLength(2);
    expect(moved).toMatchObject({ ok: true, server: { notes: 'Read the index first.', tools: { search: { note: 'Quote phrases.' } } } });
    const cleared = await service.save('u1', 's1', { notes: null });
    expect(cleared.ok && cleared.server.notes).toBeUndefined();
  });

  it('records a capture that could not start, and one whose run ended without recording anything', async () => {
    const failing = world({ startFails: 'the engine is not reachable' });
    expect(await failing.service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' } })).toMatchObject({ ok: true, server: { status: { state: 'failed', why: 'the capture could not start: the engine is not reachable' } } });

    const crashed = world();
    await crashed.service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' } });
    const runId = crashed.records.get('s1')!.capturing!.runId;
    const after = new McpServerService({ ...(crashed.service as unknown as { deps: object }).deps, finished: async (id: string) => (id === runId ? { outcome: 'failed', reason: 'the worker went away' } : undefined) } as never);
    expect(await after.get('u1', 's1')).toMatchObject({ status: { state: 'failed', why: 'the capture ended failed without recording anything: the worker went away' } });
    expect(crashed.records.get('s1')!.capturing).toBeUndefined();
  });

  it('keeps the capture a run recorded once that run is over', async () => {
    const { service, records } = world();
    await service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' } });
    const saved = records.get('s1')!;
    records.set('s1', { ...saved, captured: { tools: [{ name: 'search' }], at: '2026-10-12T13:00:00Z', fingerprint: runsFingerprint(saved.runs) } });
    const after = new McpServerService({ ...(service as unknown as { deps: object }).deps, finished: async () => ({ outcome: 'ok' }) } as never);
    expect(await after.get('u1', 's1')).toMatchObject({ status: { state: 'captured', tools: 1 } });
  });

  it('lists the person\'s running MCP deployments as hosted servers, once each, named after their tree', async () => {
    const { service, started } = world({ deployments: [{ gitappProjectId: 'p1' }] });
    const first = await service.catalogue('u1');
    expect(first.servers).toEqual([expect.objectContaining({ name: 'weather-api', runs: { where: 'hosted', deploymentId: 'd1' }, from: { projectId: 'p1' } })]);
    await service.catalogue('u1');
    expect(started).toHaveLength(1);
    expect(await service.remove('u1', first.servers[0]!.id)).toMatchObject({ ok: false, status: 409 });
  });

  it('drops a deployment\'s server once the deployment is gone', async () => {
    const { service, records } = world();
    records.set('old', { id: 'old', ownerId: 'u1', name: 'gone', runs: { where: 'hosted', deploymentId: 'd-gone' }, createdAt: 't', updatedAt: 't' });
    expect((await service.catalogue('u1')).servers).toEqual([]);
    expect(records.has('old')).toBe(false);
  });

  it('names a server so its tools can be prefixed with it', () => {
    expect(serverNameFrom('weather', new Set())).toBe('weather');
    expect(serverNameFrom('weather', new Set(['weather', 'weather-2']))).toBe('weather-3');
    expect(serverNameFrom('3d-printer', new Set())).toBe('s-3d-printer');
  });
  it('moves its grants when it is renamed, and drops them when it is removed', async () => {
    const { service, grants } = world();
    await service.add('u1', { name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' } });
    await service.save('u1', 's1', { name: 'manuals' });
    await service.save('u1', 's1', { notes: 'x' });
    await service.remove('u1', 's1');
    expect(grants).toEqual(['docs->manuals', '-manuals']);
  });
});
