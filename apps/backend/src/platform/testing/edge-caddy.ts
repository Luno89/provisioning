import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Step } from '@koala/provision';
import { containerProvider, type ContainerContext, type ContainerProvider, throwawayLabel } from '@koala/provision/testing';
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
