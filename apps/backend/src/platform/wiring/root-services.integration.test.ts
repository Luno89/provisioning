import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@temporalio/client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectTemporal } from '@koala/engine-core/temporal';
import { composeCommand, localCommands, runSteps } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { mongoClientFor } from '../lib/collection.js';
import { replicaSetProblem } from '../lib/replica-set.js';
import { temporalJwks, temporalToken } from '../lib/temporal-auth.js';
import { OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE } from '../lib/workflow-owner.js';
import { temporalDial } from '../lib/temporal-connection.js';
import { COMPOSE, rootServicesWorld } from '../testing/root-services-world.js';
import { rootServicesAt, rootServiceSteps, type RootServiceName, type RootServices } from './root-services.js';

const KEY = randomUUID().replaceAll('-', '').repeat(2);
const commands = localCommands(process.env);
const quiet = { line: () => undefined };
const made: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const down of made.splice(0)) await down();
});

async function world(): Promise<{ services: RootServices; override: (name: string, yaml: string) => string }> {
  const { places, override, down } = await rootServicesWorld();
  made.push(down);
  return { services: rootServicesAt(places, [COMPOSE], () => KEY), override };
}

async function provisioned(services: RootServices, names: RootServiceName[]): Promise<string[]> {
  const reporter = memoryReporter();
  await runSteps(rootServiceSteps(services, names), { commands }, reporter);
  return reporter.reported.flatMap((entry) => (entry.kind === 'done' || entry.kind === 'already-done' ? [`${entry.id} ${entry.kind}`] : []));
}

describe('root\'s services from their pinned compose files, on this computer\'s Docker', () => {
  it('Temporal gets its certificate and its key, starts from an empty database, takes a workflow from a token Koala signed, stays up, and is left alone the next time', async () => {
    const { services } = await world();
    expect(await provisioned(services, ['temporal'])).toEqual(['temporal-tls done', 'temporal-jwks done', 'temporal done', 'temporal-setup done']);
    expect(JSON.parse(readFileSync(services.temporal.jwksFile, 'utf8'))).toEqual(temporalJwks(KEY));
    const { temporal } = services;
    const connection = await connectTemporal(temporalDial('koala-backend', { temporal: { address: temporal.address, namespace: temporal.namespace, caPath: join(temporal.tlsDir, 'ca.crt') }, keys: { temporal: KEY } }), 'client');
    try {
      const listed = await connection.withApiKey(temporalToken(KEY, { subject: 'koala-backend', namespace: temporal.namespace, role: 'admin' }), () => connection.operatorService.listSearchAttributes({ namespace: temporal.namespace }));
      expect(Object.keys(listed.customAttributes ?? {})).toEqual(expect.arrayContaining([OWNER_ATTRIBUTE.name, PROJECT_ATTRIBUTE.name]));
      const started = await new Client({ connection, namespace: temporal.namespace }).workflow.start('rootServicesStart', { taskQueue: 'root-services-start', workflowId: `root-services-${randomUUID()}` });
      expect(started.firstExecutionRunId).not.toBe('');
    } finally {
      await connection.close();
    }
    const id = (await commands.run(composeCommand({ program: services.program, files: temporal.files, project: services.project! }, ['ps', '-q', 'temporal']), quiet)).stdout.trim();
    expect((await commands.run({ command: 'docker', args: ['inspect', '--format', '{{.State.Status}} {{.RestartCount}}', id] }, quiet)).stdout.trim()).toBe('running 0');
    expect(await provisioned(services, ['temporal'])).toEqual(['temporal-tls already-done', 'temporal-jwks already-done', 'temporal already-done', 'temporal-setup already-done']);
  }, 0);

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
