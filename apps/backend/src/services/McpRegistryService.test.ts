import { describe, it, expect, vi } from 'vitest';
import { McpRegistryService } from './McpRegistryService.js';
import type { Database } from '../lib/db-interface.js';

/**
 * Discovering what Koala has deployed.
 *
 * The registry's only job is to be RIGHT about what is callable right now. Both ways of being wrong
 * are expensive: offering a server that is gone gives the agent a tool that hangs, and hiding one
 * that is there makes it rebuild what it already has.
 */

const OWNER = 'u1';
const deployment = (over: Record<string, unknown> = {}) =>
  ({ id: 'd1', name: 'weather', clusterId: 'c1', status: 'running', appType: 'gitapp', ownerId: OWNER, ...over });

const dbWith = (deployments: unknown[], projects: unknown[] = [], trees: unknown[] = []): Database =>
  ({
    getDeployments: async () => deployments,
    getProjects: async () => projects,
    getTrees: async () => trees,
  } as unknown as Database);

/** A server that answers initialize then tools/list. */
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

// Every deployment resolves to a NodePort in these tests; absence is covered separately.
const probe = async (name: string) => `http://10.0.0.155:31860/${name}/mcp`;

describe('what the registry offers', () => {
  it('derives the list from deployments rather than keeping its own', async () => {
    /**
     * A separate table drifts the moment a deployment is destroyed, and a registry that offers a
     * pod which no longer exists is worse than none.
     */
    const svc = new McpRegistryService(dbWith([deployment(), deployment({ id: 'd2', name: 'github' })]), OWNER, probe);
    expect((await svc.list()).map((s) => s.name)).toEqual(['weather', 'github']);
  });

  it('leaves out anything not running', async () => {
    const svc = new McpRegistryService(dbWith([deployment({ status: 'destroyed' })]), OWNER, probe);
    expect(await svc.list()).toEqual([]);
  });

  it('forgets the tools of a server that stopped running', async () => {
    /**
     * The stale-offer bug. Once a pod is gone its cached tools must go with it, or the agent is
     * offered functions backed by nothing.
     */
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

    // And when it comes back it is asked again rather than trusted from before.
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
    /**
     * The reason every probe is best-effort. A registry that throws when one of eleven servers is
     * unhealthy is a registry nobody can use.
     */
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
    /**
     * Both are an empty tool list, and they mean opposite things: one is a broken server, the other
     * is a server nobody has got to yet. The UI cannot say anything useful if they look identical.
     */
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, probe, vi.fn(async () => { throw new Error('nope'); }) as never);
    expect((await svc.list())[0]!.lastSeen).toBeUndefined();
    const probed = await svc.listWithTools();
    expect(probed[0]!.lastSeen).toBeTruthy();
    expect(probed[0]!.unreachable).toContain('nope');
  });

  it('does not re-ask a healthy server on every single turn', async () => {
    // Tools change when a server is redeployed, not between turns. Probing per turn would add a
    // round trip to every step of every run.
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
    // A pod that was still starting must not be written off for ten minutes.
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
    // Killing the run over one bad call would discard everything done so far.
    const svc = new McpRegistryService(dbWith([]), OWNER, probe, vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never);
    const out = await svc.call({ id: 'd1', name: 'weather', url: 'http://x/mcp', tools: [] }, 'get-forecast', {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Could not reach weather');
  });
});

describe('the two addresses', () => {
  it('offers a sandbox the in-cluster URL and probes over the NodePort', async () => {
    /**
     * Load-bearing, and it cost a debugging round: the backend runs on the host and cannot resolve
     * `*.svc.cluster.local`, so probing through the sandbox's URL fails with "fetch failed" — which
     * reads exactly like a dead server.
     */
    const svc = new McpRegistryService(dbWith([deployment({ name: 'koala-request-42784df9' })]), OWNER, probe, okServer([{ name: 't' }]) as never);
    const [server] = await svc.list();
    expect(server!.url).toBe('http://gitapp.koala-request-42784df9.svc.cluster.local:8080/mcp');
    expect(server!.probeUrl).toContain('10.0.0.155');
  });

  it('says the harness has no route rather than blaming the server', async () => {
    // Without a NodePort there is no route at all, and "fetch failed" would attribute the harness's
    // own missing address to the deployment.
    const svc = new McpRegistryService(dbWith([deployment()]), OWNER, async () => undefined, okServer([{ name: 't' }]) as never);
    const [server] = await svc.listWithTools();
    expect(server!.unreachable).toMatch(/no route to it/i);
  });
});

describe('what a service is called', () => {
  /**
   * The deployment, its project and its repo are all named after the REQUEST — so every tool the
   * service exposed was prefixed with a hex id, while the tree had been called "Weather API MCP"
   * the whole time and nothing used it.
   */
  const dep = deployment({ name: 'koala-request-42784df9', gitappProjectId: 'p1' });
  const project = { id: 'p1', name: 'koala-request-42784df9', ownerId: OWNER };

  it('uses the tree name instead of the request id', async () => {
    const svc = new McpRegistryService(
      dbWith([dep], [project], [{ id: 't1', name: 'Weather API MCP', projectIds: ['p1'], ownerId: OWNER }]), OWNER, probe,
    );
    const [server] = await svc.list();
    expect(server!.name).toBe('weather-api-mcp');
    // The Kubernetes identity is kept — addresses, namespaces and logs still need it.
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
    // Asked for a short name, a model sometimes answers with a description; prefixing every tool
    // with that is worse than the tree name.
    const svc = new McpRegistryService(
      dbWith([dep], [project], [{ id: 't1', name: 'Weather API MCP', projectIds: ['p1'], ownerId: OWNER,
        serviceName: 'the service that wraps the weather API' }]), OWNER, probe,
    );
    expect((await svc.list())[0]!.name).toBe('weather-api-mcp');
  });

  it('falls back to the id when nothing better exists', async () => {
    // Honest rather than invented: two services both called `service` would be worse.
    const svc = new McpRegistryService(dbWith([dep], [project], []), OWNER, probe);
    expect((await svc.list())[0]!.name).toBe('koala-request-42784df9');
  });
});

describe('one tenant cannot see another\'s services', () => {
  it('offers only the caller\'s own deployments', async () => {
    /**
     * A registry that reads every deployment offers one tenant's agent the tools of another
     * tenant's service — and mcpUrlFor hands it the in-cluster address to call them with. Invisible
     * on a single-user instance right up until it is not.
     */
    const svc = new McpRegistryService(
      dbWith([deployment({ id: 'mine', name: 'mine' }), deployment({ id: 'theirs', name: 'theirs', ownerId: 'someone-else' })]),
      OWNER, probe,
    );
    expect((await svc.list()).map((s) => s.name)).toEqual(['mine']);
  });

  it('does not resolve a name through another tenant\'s tree', async () => {
    // The name is theirs to choose; reading it would leak what they called their project.
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
