import { describe, expect, it } from 'vitest';
import { closureOf, inventory, npmComponents, pinComponents } from '../../scripts/deps-inventory.mjs';

const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'koala' },
    'apps/agent': { name: 'agent', dependencies: { worker: '^1.0.0' } },
    'node_modules/agent': { link: true, resolved: 'apps/agent' },
    'node_modules/worker': { version: '1.2.0', dependencies: { proto: '^7.0.0', ms: '^2.0.0' } },
    'node_modules/worker/node_modules/proto': { version: '8.0.1' },
    'node_modules/proto': { version: '7.5.0' },
    'node_modules/ms': { version: '2.1.3' },
    'node_modules/@scope/thing': { version: '3.0.0', dev: true },
    'apps/agent/node_modules/ms': { version: '2.1.3' },
  },
};

const pins = {
  components: [
    { kind: 'image', name: 'caddy', version: '2.10.2', source: 'docker.io/library/caddy:2.10.2-alpine', github: 'caddyserver/caddy', osv: { ecosystem: 'Go', name: 'github.com/caddyserver/caddy/v2' } },
    { kind: 'image', name: 'headscale/headscale', version: 'v0.29.2', source: 'docker.io/headscale/headscale:v0.29.2' },
    { kind: 'action', name: 'actions/checkout', version: 'v4.4.0', commit: 'a'.repeat(40), source: 'https://github.com/actions/checkout' },
    { kind: 'binary', name: 'k3s', version: 'v1.36.4+k3s1', sha256: 'b'.repeat(64), source: 'https://example.invalid/k3s' },
  ],
  unpinned: [{ name: 'tailscale', how: 'curl | sh', usedIn: ['scripts/instance/install.sh'] }],
};

const props = (component: { properties?: { name: string; value: string }[] }) => Object.fromEntries((component.properties ?? []).map((entry) => [entry.name, entry.value]));

describe('the inventory of a release', () => {
  it('lists each npm package once, scoped names encoded, development-only ones marked excluded', () => {
    const found = npmComponents(lock, 'koala');
    expect(found.map((component: { purl: string }) => component.purl)).toEqual([
      'pkg:npm/%40scope/thing@3.0.0', 'pkg:npm/ms@2.1.3', 'pkg:npm/proto@7.5.0', 'pkg:npm/proto@8.0.1', 'pkg:npm/worker@1.2.0',
    ]);
    expect(found[0]).toMatchObject({ scope: 'excluded' });
    expect(props(found[0]!)).toMatchObject({ 'koala:dev': 'true', 'koala:in': 'koala' });
    expect(found[1]).toMatchObject({ scope: 'required' });
  });

  it('follows what a workspace\'s packages need the way Node resolves them, for the machine agent', () => {
    const closure = closureOf(lock, ['worker', 'ms'], 'apps/agent');
    expect(Object.keys(closure.packages).sort()).toEqual(['apps/agent/node_modules/ms', 'node_modules/ms', 'node_modules/worker', 'node_modules/worker/node_modules/proto']);
  });

  it('gives each pinned component its kind, source, checksum and where OSV knows it, and lists what is unpinned', () => {
    const [caddy, headscale, checkout, k3s, tailscale] = pinComponents(pins);
    expect(caddy).toMatchObject({ type: 'container', purl: 'pkg:docker/library/caddy@2.10.2' });
    expect(props(caddy)).toMatchObject({ 'koala:osv-ecosystem': 'Go', 'koala:osv-name': 'github.com/caddyserver/caddy/v2', 'koala:github': 'caddyserver/caddy' });
    expect(headscale).toMatchObject({ purl: 'pkg:docker/headscale/headscale@v0.29.2' });
    expect(checkout).toMatchObject({ purl: 'pkg:github/actions/checkout@v4.4.0' });
    expect(props(checkout)['koala:commit']).toBe('a'.repeat(40));
    expect(k3s).toMatchObject({ type: 'application', hashes: [{ alg: 'SHA-256', content: 'b'.repeat(64) }] });
    expect(props(tailscale)).toMatchObject({ 'koala:kind': 'unpinned', 'koala:how': 'curl | sh' });
  });

  it('is a CycloneDX 1.5 document naming the release', () => {
    const bom = inventory({ lock, machineLock: undefined, pins, release: 'v2026.10.29', now: new Date('2026-10-29T00:00:00Z'), serial: '00000000-0000-4000-8000-000000000000' });
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000000', metadata: { timestamp: '2026-10-29T00:00:00.000Z', component: { name: 'koala', version: 'v2026.10.29' } } });
    const refs = bom.components.map((component: { 'bom-ref': string }) => component['bom-ref']);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
