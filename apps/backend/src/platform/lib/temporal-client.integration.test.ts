import { randomUUID } from 'node:crypto';
import { Connection } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE } from './workflow-owner.js';
import { connectTemporalAs, getTemporalClient, readyNamespace, refuseWorkWith, reportTemporalTo } from './temporal-client.js';
import { testKeys } from '../testing/keys.js';

let connection: Connection;
const made: string[] = [];
const quiet = (): void => undefined;

beforeAll(async () => { connection = await Connection.connect({ address: inject('temporalAddress') }); });
afterAll(async () => {
  for (const namespace of made) await connection.operatorService.deleteNamespace({ namespace });
  await connection.close();
});

describe('a Koala readying its Temporal namespace, as a plain Temporal server makes none', () => {
  it('registers its namespace when the server has none, with the owner search attribute, and is a no-op the second time', async () => {
    const namespace = `koala-ready-${randomUUID()}`;
    made.push(namespace);
    await readyNamespace(connection, namespace, quiet);
    await readyNamespace(connection, namespace, quiet);
    const described = await connection.workflowService.describeNamespace({ namespace });
    expect(described.namespaceInfo?.name).toBe(namespace);
    const attributes = await connection.operatorService.listSearchAttributes({ namespace });
    expect(Object.keys(attributes.customAttributes ?? {})).toContain(OWNER_ATTRIBUTE.name);
  });

  it('readies a namespace from two of the Koala\'s processes at once, both ending with the namespace and both search attributes there', async () => {
    const namespaces = Array.from({ length: 8 }, () => `koala-ready-${randomUUID()}`);
    made.push(...namespaces);
    const other = await Connection.connect({ address: inject('temporalAddress') });
    try {
      const readied = await Promise.allSettled(namespaces.flatMap((namespace) => [connection, other].map((each) => readyNamespace(each, namespace, quiet))));
      expect(readied.filter((each) => each.status === 'rejected')).toEqual([]);
    } finally {
      await other.close();
    }
    for (const namespace of namespaces) {
      const described = await connection.workflowService.describeNamespace({ namespace });
      expect(described.namespaceInfo?.name).toBe(namespace);
      const attributes = await connection.operatorService.listSearchAttributes({ namespace });
      expect(Object.keys(attributes.customAttributes ?? {})).toEqual(expect.arrayContaining([OWNER_ATTRIBUTE.name, PROJECT_ATTRIBUTE.name]));
    }
  });

  it('tells this process Temporal answers only once its namespace is ready, never when readying it failed', async () => {
    const told: string[] = [];
    reportTemporalTo({ failed: (_dependency, err) => { told.push('failed'); return err; }, answered: () => { told.push('answered'); } });
    refuseWorkWith(async () => ({ owner: false, project: false }));
    connectTemporalAs({ temporal: { address: inject('temporalTlsAddress'), namespace: 'x'.repeat(1_001), caPath: inject('temporalCa') }, keys: testKeys('temporal-client') });
    await expect(getTemporalClient()).rejects.toThrow();
    expect(told).toEqual(['failed']);
  });
});
