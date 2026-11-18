import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeCommand, localCommands, runSteps } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { mongoClientFor } from '../lib/collection.js';
import { replicaSetProblem } from '../lib/replica-set.js';
import { temporalJwks } from '../lib/temporal-auth.js';
import { rootServiceSteps, type RootServiceName, type RootServices } from './root-services.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const COMPOSE = join(REPO, 'bin/docker-compose');
const KEY = randomUUID().replaceAll('-', '').repeat(2);
const commands = localCommands(process.env);
const quiet = { line: () => undefined };
const made: { services: RootServices; folder: string }[] = [];

afterEach(async () => {
  for (const { services, folder } of made.splice(0)) {
    for (const files of [services.temporal.files, services.mongo.files, services.headscale.files, services.registry.files]) {
      await commands.run(composeCommand({ program: services.program, files, project: services.project! }, ['down', '-v', '--remove-orphans']), quiet);
    }
    rmSync(folder, { recursive: true, force: true });
  }
});

async function world(): Promise<{ services: RootServices; folder: string; ports: number[]; override: (name: string, yaml: string) => string }> {
  const folder = mkdtempSync(join(tmpdir(), 'koala-root-services-'));
  const ports = await Promise.all(Array.from({ length: 5 }, () => portToHandOn()));
  const [temporal, mongo, headscale, writer, reader] = ports as [number, number, number, number, number];
  const id = randomUUID().slice(0, 8);
  const override = (name: string, yaml: string): string => {
    const file = join(folder, `${name}.yml`);
    writeFileSync(file, yaml);
    return file;
  };
  const tlsDir = join(folder, 'temporal-tls');
  const jwksFile = join(folder, 'temporal-keys', 'temporal-jwks.json');
  const services: RootServices = {
    program: [COMPOSE],
    project: `koala-root-services-${id}`,
    temporal: {
      files: [join(REPO, 'docker-compose.temporal.yml'), override('temporal', [
        'services:',
        '  temporal-keys:',
        `    volumes: !override ["${join(folder, 'temporal-keys')}:/srv/.well-known:ro"]`,
        '  temporal:',
        `    ports: !override ["127.0.0.1:${temporal}:7233"]`,
        `    volumes: !override ["tf-data:/home/temporal/temporal", "${tlsDir}:/etc/temporal/tls:ro"]`,
        '',
      ].join('\n'))],
      address: `127.0.0.1:${temporal}`,
      namespace: 'default',
      tlsDir,
      jwksFile,
      key: () => KEY,
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
  };
  made.push({ services, folder });
  return { services, folder, ports, override };
}

async function provisioned(services: RootServices, names: RootServiceName[]): Promise<string[]> {
  const reporter = memoryReporter();
  await runSteps(rootServiceSteps(services, names), { commands }, reporter);
  return reporter.reported.flatMap((entry) => (entry.kind === 'done' || entry.kind === 'already-done' ? [`${entry.id} ${entry.kind}`] : []));
}

describe('root\'s services from their pinned compose files, on this computer\'s Docker', () => {
  it('Temporal gets its certificate and its key, starts, answers over TLS to its CA, and is left alone the next time', async () => {
    const { services } = await world();
    expect(await provisioned(services, ['temporal'])).toEqual(['temporal-tls done', 'temporal-jwks done', 'temporal done']);
    expect(JSON.parse(readFileSync(services.temporal.jwksFile, 'utf8'))).toEqual(temporalJwks(KEY));
    expect(await provisioned(services, ['temporal'])).toEqual(['temporal-tls already-done', 'temporal-jwks already-done', 'temporal already-done']);
  });

  it('Mongo starts as a replica set, and one running on its own is started again as one, its data kept', async () => {
    const { services, override } = await world();
    const standalone = override('mongo-standalone', 'services:\n  mongodb:\n    entrypoint: !override ["docker-entrypoint.sh", "mongod", "--bind_ip_all"]\n');
    await commands.run(composeCommand({ program: services.program, files: [...services.mongo.files, standalone], project: services.project! }, ['up', '-d']), quiet);
    const client = mongoClientFor(`mongodb://${services.mongo.address}/`);
    try {
      expect(await replicaSetProblem(client)).toContain('not as a replica set');
      expect(await provisioned(services, ['mongo'])).toEqual(['mongo done']);
      expect(await replicaSetProblem(client)).toBeUndefined();
    } finally {
      await client.close();
    }
    expect(await provisioned(services, ['mongo'])).toEqual(['mongo already-done']);
  });

  it('Headscale starts and answers its health check', async () => {
    const { services } = await world();
    expect(await provisioned(services, ['headscale'])).toEqual(['headscale done']);
    expect((await fetch(`${services.headscale.url}/health`)).status).toBe(200);
  });

  it('the registry starts, its writer answering for pushes', async () => {
    const { services } = await world();
    expect(await provisioned(services, ['registry'])).toEqual(['registry done']);
    expect((await fetch(`http://${services.registry.push}/v2/`)).status).toBe(200);
  });
});
