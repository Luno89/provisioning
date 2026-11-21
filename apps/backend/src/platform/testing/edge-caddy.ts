import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Step } from '@koala/provision';
import { containerProvider, type ContainerContext, type ContainerProvider, throwawayLabel } from '@koala/provision/testing';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { caddyStep } from '../wiring/root-services.js';

const CHART_VALUES = resolve(import.meta.dirname, '../../../../../charts/instance/values.yaml');

export const EDGE_TEST_IMAGE: string = (parse(readFileSync(CHART_VALUES, 'utf8')) as { edge: { image: string } }).edge.image;

export interface EdgeCaddy {
  container: ContainerProvider;
  step: Step<ContainerContext>;
  admin(): string;
}

export function edgeCaddy(caddyfile: string, options: { folder?: string; publish?: number[]; mounts?: string[] } = {}): EdgeCaddy {
  const folder = options.folder ?? mkdtempSync(join(tmpdir(), 'koala-caddy-'));
  chmodSync(folder, 0o755);
  writeFileSync(join(folder, 'Caddyfile'), caddyfile);
  const publish = [2019, ...(options.publish ?? [])];
  const container = containerProvider({
    name: `koala-caddy-test-${randomUUID().slice(0, 8)}`,
    image: EDGE_TEST_IMAGE,
    run: [...throwawayLabel(), ...publish.flatMap((port) => ['-p', `127.0.0.1::${port}`]), '-v', `${join(folder, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, ...(options.mounts ?? []).flatMap((mount) => ['-v', mount])],
    command: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile'],
    publish,
  });
  const admin = (): string => `http://127.0.0.1:${container.published(2019)}`;
  return { container, step: caddyStep(container, () => ({ url: admin() })), admin };
}

export interface RootCaddy {
  container: ContainerProvider;
  step: Step<ContainerContext>;
  https: number;
  rootCertificate(): Promise<string>;
}

export interface RootCaddyPorts {
  https: number;
  http: number;
  metrics: number;
}

const ROOT_CADDY_FOLDERS = { tls: '/etc/caddy/tls', apps: '/etc/caddy/apps', instances: '/etc/caddy/instances', 'instance-sites': '/etc/caddy/instance-sites', admin: '/run/caddy-admin', log: '/var/log/caddy' };

const ROOT_GLOBAL_OPTIONS = '\n{\n';

const ROOT_METRICS_SITE = 'http://127.0.0.1:2019 {';

export function rootCaddy(caddyfile: string, folder: string, env: Record<string, string>, ports: RootCaddyPorts): RootCaddy {
  if (!caddyfile.includes(ROOT_GLOBAL_OPTIONS)) throw new Error('root\'s Caddyfile has no global options block to name this Caddy\'s ports in');
  if (!caddyfile.includes(ROOT_METRICS_SITE)) throw new Error(`root's Caddyfile no longer serves its metrics at "${ROOT_METRICS_SITE}"`);
  writeFileSync(join(folder, 'Caddyfile'), caddyfile
    .replace(ROOT_GLOBAL_OPTIONS, `${ROOT_GLOBAL_OPTIONS}\thttps_port ${ports.https}\n\thttp_port ${ports.http}\n`)
    .replace(ROOT_METRICS_SITE, `http://127.0.0.1:${ports.metrics} {`));
  const container = containerProvider({
    name: `koala-root-caddy-test-${randomUUID().slice(0, 8)}`,
    image: EDGE_TEST_IMAGE,
    run: [...throwawayLabel(), '--network', 'host',
      '-v', `${join(folder, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      ...Object.entries(ROOT_CADDY_FOLDERS).flatMap(([sub, inside]) => ['-v', `${join(folder, sub)}:${inside}`]),
      ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`])],
    command: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile'],
  });
  const rootCertificate = async (): Promise<string> => {
    const read = await nodeProcesses.run({ command: 'docker', args: ['exec', container.name, 'cat', '/data/caddy/pki/authorities/local/root.crt'] });
    if (read.code !== 0) throw new Error(`Caddy's own certificate authority could not be read from ${container.name}: ${read.stderr}`);
    return read.stdout;
  };
  return { container, step: caddyStep(container, () => ({ socket: join(folder, 'admin', 'admin.sock') })), https: ports.https, rootCertificate };
}
