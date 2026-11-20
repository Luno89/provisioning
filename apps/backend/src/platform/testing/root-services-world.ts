import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { composeCommand, localCommands } from '@koala/provision';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import type { RootServicePlaces } from '../wiring/root-services.js';

export const REPO = resolve(import.meta.dirname, '../../../../..');
export const COMPOSE = join(REPO, 'bin/docker-compose');

export interface RootServicesWorld {
  places: RootServicePlaces & { project: string };
  folder: string;
  override: (name: string, yaml: string) => string;
  down: () => Promise<void>;
}

export async function rootServicesWorld(): Promise<RootServicesWorld> {
  const folder = mkdtempSync(join(tmpdir(), 'koala-root-services-'));
  const [temporal, mongo, headscale, writer, reader] = await Promise.all(Array.from({ length: 5 }, () => portToHandOn())) as [number, number, number, number, number];
  const id = randomUUID().slice(0, 8);
  const override = (name: string, yaml: string): string => {
    const file = join(folder, `${name}.yml`);
    writeFileSync(file, yaml);
    return file;
  };
  const tlsDir = join(folder, 'temporal-tls');
  const places: RootServicesWorld['places'] = {
    project: `koala-root-services-${id}`,
    temporal: {
      files: [join(REPO, 'docker-compose.temporal.yml'), override('temporal', [
        'services:',
        '  temporal-keys:',
        `    volumes: !override ["${join(folder, 'temporal-keys')}:/srv/.well-known:ro"]`,
        '  temporal:',
        `    ports: !override ["127.0.0.1:${temporal}:7233"]`,
        `    volumes: !override ["tf-data:/home/temporal/temporal", "${join(REPO, 'charts/instance/files/temporal-dynamic-config.yaml')}:/etc/temporal/config/dynamicconfig/docker.yaml:ro", "${tlsDir}:/etc/temporal/tls:ro"]`,
        '',
      ].join('\n'))],
      address: `127.0.0.1:${temporal}`,
      namespace: 'default',
      tlsDir,
      jwksFile: join(folder, 'temporal-keys', 'temporal-jwks.json'),
    },
    mongo: {
      files: [join(REPO, 'docker-compose.mongo.yml'), override('mongo', `services:\n  mongodb:\n    ports: !override ["127.0.0.1:${mongo}:27017"]\n`)],
      address: `127.0.0.1:${mongo}`,
    },
    headscale: {
      files: [join(REPO, 'docker-compose.headscale.yml'), override('headscale', `services:\n  headscale:\n    container_name: koala-headscale-${id}\n    ports: !override ["127.0.0.1:${headscale}:8080"]\n`)],
      url: `http://127.0.0.1:${headscale}`,
    },
    registry: {
      files: [join(REPO, 'docker-compose.registry.yml'), override('registry', [
        'services:',
        '  registry-writer:',
        `    container_name: koala-registry-writer-${id}`,
        `    ports: !override ["127.0.0.1:${writer}:5000"]`,
        '  registry-reader:',
        `    container_name: koala-registry-reader-${id}`,
        `    ports: !override ["127.0.0.1:${reader}:5000"]`,
        '',
      ].join('\n'))],
      push: `127.0.0.1:${writer}`,
    },
    caddy: { files: [join(REPO, 'docker-compose.caddy.yml')], admin: { socket: join(folder, 'caddy-admin.sock') } },
  };
  const down = async (): Promise<void> => {
    const commands = localCommands(process.env);
    for (const files of [places.temporal.files, places.mongo.files, places.headscale.files, places.registry.files]) {
      await commands.run(composeCommand({ program: [COMPOSE], files, project: places.project }, ['down', '-v', '--remove-orphans']), { line: () => undefined });
    }
    rmSync(folder, { recursive: true, force: true });
  };
  return { places, folder, override, down };
}
