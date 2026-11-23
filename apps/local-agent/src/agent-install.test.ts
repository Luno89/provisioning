import { describe, expect, it } from 'vitest';
import { ACP_REGISTRY, installAgent, type InstallDeps } from './agent-install.js';

const deps = (fetchFn: typeof fetch): InstallDeps => ({
  fetch: fetchFn,
  platform: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.0.0',
  unzip: async () => { throw new Error('nothing is unzipped here'); },
  npm: async () => { throw new Error('npm must not be asked'); },
});

describe('installing an agent when the registry cannot be read', () => {
  it('answers that the install failed, with why, when the machine cannot reach the registry', async () => {
    const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await installAgent({ registry: 'claude-acp' }, deps(offline))).toEqual({ ok: false, output: 'installing claude-acp failed: fetch failed' });
  });

  it('answers that the install failed, with why, when the registry lists the agent in something that is not JSON', async () => {
    const garbled = (async (input: string | URL | Request) => {
      if (String(input) !== `${ACP_REGISTRY}/claude-acp/agent.json`) throw new Error(`asked for ${String(input)}`);
      return new Response('<html>not json</html>');
    }) as typeof fetch;
    const outcome = await installAgent({ registry: 'claude-acp' }, deps(garbled));
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/^installing claude-acp failed: .*JSON/);
  });
});
