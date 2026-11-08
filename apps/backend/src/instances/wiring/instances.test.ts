import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adminEdge } from '../services/InstanceAddresses.js';
import { edgeOf } from './instances.js';
import { edgeSettingsFrom } from '../lib/edge-settings.js';

const edgeFrom = (env: Record<string, string>) => edgeOf(edgeSettingsFrom(env), () => undefined);

const SETTINGS = { EDGE_ADMIN_URL: 'http://localhost:2019', EDGE_CADDYFILE: '/etc/edge/Caddyfile', EDGE_SITES: '/data/caddy/apps' };

describe('the edge an instance runs beside its backend', () => {
  it('is read from the settings the chart gives every instance, its local port only where it has one and its name only with a domain', () => {
    expect(edgeFrom({ ...SETTINGS, EDGE_LOCAL_PORT: '8000' })).toMatchObject({ name: undefined, localPort: 8000, sites: '/data/caddy/apps' });
    expect(edgeFrom({ ...SETTINGS, INGRESS_DOMAIN: 'koala.dev', INSTANCE_NAME: 'luno' })).toMatchObject({ name: 'luno', localPort: undefined });
  });

  it('is none when none of its settings are given, and stops the backend when only some are, or they make no sense', () => {
    expect(edgeFrom({})).toBeUndefined();
    expect(() => edgeFrom({ EDGE_ADMIN_URL: 'http://localhost:2019' })).toThrow('EDGE_CADDYFILE, EDGE_SITES are not set');
    expect(() => edgeFrom({ ...SETTINGS, EDGE_LOCAL_PORT: 'eight' })).toThrow('EDGE_LOCAL_PORT is not a port: eight');
    expect(() => edgeFrom({ ...SETTINGS, INGRESS_DOMAIN: 'koala.dev' })).toThrow('INGRESS_DOMAIN is set without INSTANCE_NAME');
  });

  it('loads its whole Caddyfile through its admin API, and says what it refused', async () => {
    const caddyfile = join(mkdtempSync(join(tmpdir(), 'koala-edge-')), 'Caddyfile');
    writeFileSync(caddyfile, 'import /data/caddy/apps/*.caddy\n');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 200 })).mockResolvedValueOnce(new Response('adapting config: unknown directive', { status: 400 }));
    const edge = adminEdge({ name: 'luno', localPort: 8000, sites: '/data/caddy/apps', adminUrl: 'http://localhost:2019', caddyfile }, () => undefined, fetchImpl);
    await edge.reload();
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:2019/load', { method: 'POST', headers: { 'content-type': 'text/caddyfile' }, body: 'import /data/caddy/apps/*.caddy\n' });
    await expect(edge.reload()).rejects.toThrow('the edge refused its config (400): adapting config: unknown directive');
    expect(edge.nestedReady()).toBe(false);
  });
});
