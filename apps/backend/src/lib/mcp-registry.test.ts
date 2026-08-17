import { describe, it, expect } from 'vitest';
import {
  looksLikeMcp, resolveForPersona, mcpGaps, describeServers, mcpUrlFor, mcpProbeUrlFor, type McpServer,
} from './mcp-registry.js';
import type { DeploymentMetadata } from './types.js';

/**
 * Knowing what Koala has built, so it can use it.
 *
 * The registry's job is to be RIGHT about what is callable. A registry that offers tools from a pod
 * that is not running is worse than none: the agent calls it, waits for a timeout, and reports a
 * mystery that has nothing to do with the task.
 */

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata =>
  ({ id: 'd1', name: 'weather', clusterId: 'c1', status: 'running', appType: 'gitapp', ...over } as DeploymentMetadata);

const server = (over: Partial<McpServer> = {}): McpServer =>
  ({ id: 'd1', name: 'weather', url: 'http://weather/mcp', tools: [{ name: 'get-forecast' }], ...over });

describe('what counts as a callable server', () => {
  it('takes a running Koala-built service', () => {
    expect(looksLikeMcp(dep())).toBe(true);
  });

  it('refuses one that is not running', () => {
    /**
     * The important negative. Offering tools from a pod that is deploying, stopped or destroyed
     * gives the agent a tool that hangs — and the reason is three layers from where it fails.
     */
    for (const status of ['deploying', 'destroyed', 'failed', 'destroying']) {
      expect(looksLikeMcp(dep({ status: status as never }))).toBe(false);
    }
  });

  it('refuses an app that is not one of ours', () => {
    // A running Postgres does not speak MCP, and asking it will not go well.
    expect(looksLikeMcp(dep({ appType: 'odoo' as never }))).toBe(false);
  });

  it('addresses the gitapp Service, not the deployment name', () => {
    /**
     * The deployment is called `koala-request-42784df9` and its Service is `gitapp` in a namespace
     * of that name. Building the URL from the deployment name produced
     * `koala-request-42784df9.koala-request-koala-request-42784df9`, which resolves to nothing —
     * and the failure reads as a dead server.
     */
    expect(mcpUrlFor(dep({ name: 'koala-request-42784df9' } as never)))
      .toBe('http://gitapp.koala-request-42784df9.svc.cluster.local:8080/mcp');
  });

  it('gives the backend a different address from the sandbox', () => {
    /**
     * Load-bearing. The backend runs on the host and cannot resolve `*.svc.cluster.local` at all,
     * so introspecting through the in-cluster URL fails with a bare "fetch failed" that looks
     * exactly like a dead server. Confirmed live: the NodePort works from the host, the cluster DNS
     * name does not.
     */
    expect(mcpProbeUrlFor('10.0.0.155', 31860)).toBe('http://10.0.0.155:31860/mcp');
    expect(mcpProbeUrlFor('10.0.0.155', 31860)).not.toContain('svc.cluster.local');
  });
});

describe('which servers a persona gets', () => {
  it('gives it nothing unless it asked', () => {
    /**
     * Not automatic, deliberately. Every tool offered costs prompt tokens on EVERY turn, and a
     * persona that quietly gained eleven tools would get slower and more expensive with no change
     * anybody made.
     */
    expect(resolveForPersona(undefined, [server()]).servers).toEqual([]);
    expect(resolveForPersona([], [server()]).servers).toEqual([]);
  });

  it('gives it the ones it named', () => {
    const out = resolveForPersona(['weather'], [server(), server({ id: 'd2', name: 'github' })]);
    expect(out.servers.map((s) => s.name)).toEqual(['weather']);
  });

  it('REPORTS a server it asked for and cannot have', () => {
    /**
     * Silently handing back a smaller toolset is how a persona ends up failing a run for a reason
     * nothing on screen explains. A named server that is not running is a configuration mistake and
     * should read as one.
     */
    const out = resolveForPersona(['weather', 'gone'], [server()]);
    expect(out.servers.map((s) => s.name)).toEqual(['weather']);
    expect(out.missing).toEqual(['gone']);
  });
});

describe('where capability and network policy disagree', () => {
  it('flags a server the sandbox cannot actually reach', () => {
    /**
     * The worst of both worlds: the model can see the tool and every call times out, with the real
     * cause — a NetworkPolicy — appearing nowhere near the failure. Reporting it up front turns a
     * baffling run into a configuration error.
     */
    const gaps = mcpGaps([server()], [{ namespace: 'gitea', ports: [3000] }], () => 'koala-apps');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('koala-apps');
    expect(gaps[0]).toMatch(/time out/);
  });

  it('says nothing when the egress allows it', () => {
    expect(mcpGaps([server()], [{ namespace: 'koala-apps', ports: [8080] }], () => 'koala-apps')).toEqual([]);
  });

  it('flags everything when a persona is sealed', () => {
    // A sealed persona reaches nothing, so every server it was given is unreachable.
    expect(mcpGaps([server()], [], () => 'koala-apps')).toHaveLength(1);
    expect(mcpGaps([server()], undefined, () => 'koala-apps')).toHaveLength(1);
  });
});

describe('telling the model what it can call', () => {
  it('names the service, not just the tools', () => {
    /**
     * A model given eleven functions with no idea where they came from can reason about which
     * FUNCTION to call, not which SERVICE — which is what makes reuse a choice rather than an
     * accident.
     */
    const text = describeServers([server({ tools: [{ name: 'get-forecast' }, { name: 'get-current' }] })]);
    expect(text).toContain('weather: get-forecast, get-current');
    expect(text).toMatch(/built and deployed by this harness/i);
    expect(text).toMatch(/Prefer calling one of these over rebuilding/i);
  });

  it('says nothing at all when there are none', () => {
    // A fresh install must carry no dead weight in every prompt.
    expect(describeServers([])).toBe('');
  });

  it('is honest about a server that reported no tools', () => {
    // Listing it as empty is better than omitting it: "it is there and exposes nothing" is a fact
    // worth having when deciding whether to rebuild.
    expect(describeServers([server({ tools: [] })])).toContain('no tools reported');
  });
});
