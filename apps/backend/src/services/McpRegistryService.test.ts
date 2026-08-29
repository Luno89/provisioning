import { describe, it, expect, vi } from 'vitest';
import { McpRegistryService } from './McpRegistryService.js';
import type { Database } from '../lib/db-interface.js';

const OWNER = 'u1';
const deployment = (over: Record<string, unknown> = {}) =>
  ({ id: 'd1', name: 'weather', clusterId: 'c1', status: 'running', appType: 'gitapp', ownerId: OWNER, ...over });

const dbWith = (deployments: unknown[], projects: unknown[] = [], trees: unknown[] = []): Database =>
  ({
    getDeployments: async () => deployments,
    getProjects: async () => projects,
    getTrees: async () => trees,
  } as unknown as Database);

const okServer = (tools: { name: string }[]) => vi.fn(async (_url: any, init: any) => {
  const body = JSON.parse(String(init.body));
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', serverInfo: { name: 'weather-mcp' } }
    : { tools };
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 's1' }),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
  } as never;
});

const probe = async (name: string) => `http://10.0.0.155:31860/${name}/mcp`;

describe('what the registry offers', () => {
  it('derives the list from deployments rather than keeping its own', async () => {
    const svc = new McpRegistryService(dbWith([deployment(), deployment({ id: 'd2', name: 'github' })]), OWNER, probe);
    expect((await svc.list()).map((s) => s.name)).toEqual(['weather', 'github']);
  });

  it('leaves out anything not running', async () => {
    const svc = new McpRegistryService(dbWith([deployment({ status: 'destroyed' })]), OWNER, probe);
    expect(await svc.list()).toEqual([]);
  });

  it('forgets the tools of a server that stopped running', async () => {
    const deployments = [deployment()];
    const db = {
      getDeployments: async () => deployments,
      getProjects: async () => [],
      getTrees: async () => [],
    } as unknown as Database;
    const svc = new McpRegistryService(db, OWNER, probe, okServer([{ name: 'get-forecast' }]) as never);

    expect((await svc.listWithTools())[0]!.tools).toHaveLength(1);
    deployments[0]!.status = 'destroyed';
    expect(await svc.list()).toEqual([]);

    deployments[0]!.status = 'running';
    expect((await svc.list())[0]!.tools).toEqual([]);
  });
});

describe('asking a server what it can do', () => {
  it('reports its tools', async () => {
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, okServer([{ name: 'get-forecast' }, { name: 'get-current' }]) as never);
    const [server] = await svc.listWithTools();
    expect(server!.tools.map((t) => t.name)).toEqual(['get-forecast', 'get-current']);
    expect(server!.lastSeen).toBeTruthy();
  });

  it('does not let one wedged server hide the others', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('broken')) throw new Error('ECONNREFUSED');
      return okServer([{ name: 'ok-tool' }])(url, init);
    });
    const svc = new McpRegistryService(
      dbWith([deployment({ id: 'd1', name: 'broken' }), deployment({ id: 'd2', name: 'fine' })]),
      OWNER, probe, fetchImpl as never,
    );
    const servers = await svc.listWithTools();
    expect(servers.find((s) => s.name === 'broken')!.unreachable).toContain('ECONNREFUSED');
    expect(servers.find((s) => s.name === 'fine')!.tools).toHaveLength(1);
  });

  it('tells "asked and got nothing" apart from "never asked"', async () => {
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, vi.fn(async () => { throw new Error('nope'); }) as never);
    expect((await svc.list())[0]!.lastSeen).toBeUndefined();
    const probed = await svc.listWithTools();
    expect(probed[0]!.lastSeen).toBeTruthy();
    expect(probed[0]!.unreachable).toContain('nope');
  });

  it('does not re-ask a healthy server on every single turn', async () => {
    const fetchImpl = okServer([{ name: 'x' }]);
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, fetchImpl as never);
    await svc.listWithTools();
    const afterFirst = fetchImpl.mock.calls.length;
    await svc.listWithTools();
    expect(fetchImpl.mock.calls.length).toBe(afterFirst);
  });

  it('re-asks when told to, so a redeploy is picked up', async () => {
    const fetchImpl = okServer([{ name: 'x' }]);
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, fetchImpl as never);
    await svc.listWithTools();
    const afterFirst = fetchImpl.mock.calls.length;
    await svc.listWithTools(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('retries a server that failed rather than caching the failure', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (fail) throw new Error('starting up');
      return okServer([{ name: 'ready' }])(url, init);
    });
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, fetchImpl as never);
    expect((await svc.listWithTools())[0]!.unreachable).toBeTruthy();
    fail = false;
    expect((await svc.listWithTools())[0]!.tools).toHaveLength(1);
  });
});

describe('calling a tool', () => {
  it('returns an unreachable server as a result, not a throw', async () => {
    const svc = new McpRegistryService(dbWith([]), OWNER, probe, vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never);
    const out = await svc.call({ id: 'd1', name: 'weather', url: 'http://x/mcp', tools: [] }, 'get-forecast', {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Could not reach weather');
  });
});

describe('the two addresses', () => {
  it('offers a sandbox the in-cluster URL and probes over the NodePort', async () => {
    const svc = new McpRegistryService(dbWith([deployment({ name: 'koala-request-42784df9' })]), OWNER, probe, okServer([{ name: 't' }]) as never);
    const [server] = await svc.list();
    expect(server!.url).toBe('http://gitapp.koala-request-42784df9.svc.cluster.local:8080/mcp');
    expect(server!.probeUrl).toContain('10.0.0.155');
  });

  it('says the harness has no route rather than blaming the server', async () => {
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, async () => undefined, okServer([{ name: 't' }]) as never);
    const [server] = await svc.listWithTools();
    expect(server!.unreachable).toMatch(/no route to it/i);
  });
});

describe('what a service is called', () => {
  const dep = deployment({ name: 'koala-request-42784df9', gitappProjectId: 'p1' });
  const project = { id: 'p1', name: 'koala-request-42784df9', ownerId: OWNER };

  it('uses the tree name instead of the request id', async () => {
    const svc = new McpRegistryService(
      dbWith([dep], [project], [{ id: 't1', name: 'Weather API MCP', projectIds: ['p1'], ownerId: OWNER }]), OWNER, probe,
    );
    const [server] = await svc.list();
    expect(server!.name).toBe('weather-api-mcp');
    expect(server!.deploymentName).toBe('koala-request-42784df9');
    expect(server!.url).toContain('koala-request-42784df9');
  });

  it('prefers a name the planner declared', async () => {
    const svc = new McpRegistryService(
      dbWith([dep], [project], [{ id: 't1', name: 'Weather API MCP', projectIds: ['p1'], serviceName: 'weather', ownerId: OWNER }]), OWNER, probe,
    );
    expect((await svc.list())[0]!.name).toBe('weather');
  });

  it('ignores a declared name that is really a sentence', async () => {
    const svc = new McpRegistryService(
      dbWith([dep], [project], [{ id: 't1', name: 'Weather API MCP', projectIds: ['p1'], ownerId: OWNER,
        serviceName: 'the service that wraps the weather API' }]), OWNER, probe,
    );
    expect((await svc.list())[0]!.name).toBe('weather-api-mcp');
  });

  it('falls back to the id when nothing better exists', async () => {
    const svc = new McpRegistryService(dbWith([dep], [project], []), OWNER, probe);
    expect((await svc.list())[0]!.name).toBe('koala-request-42784df9');
  });
});

describe('one tenant cannot see another\'s services', () => {
  it('offers only the caller\'s own deployments', async () => {
    const svc = new McpRegistryService(
      dbWith([deployment({ id: 'mine', name: 'mine' }), deployment({ id: 'theirs', name: 'theirs', ownerId: 'someone-else' })]),
      OWNER, probe,
    );
    expect((await svc.list()).map((s) => s.name)).toEqual(['mine']);
  });

  it('does not resolve a name through another tenant\'s tree', async () => {
    const svc = new McpRegistryService(
      dbWith(
        [deployment({ name: 'koala-request-42784df9', gitappProjectId: 'p1' })],
        [{ id: 'p1', name: 'koala-request-42784df9', ownerId: 'someone-else' }],
        [{ id: 't1', name: 'Their Secret Project', projectIds: ['p1'], ownerId: 'someone-else' }],
      ),
      OWNER, probe,
    );
    const [server] = await svc.list();
    expect(server!.name).toBe('koala-request-42784df9');
    expect(server!.name).not.toContain('secret');
  });
});
