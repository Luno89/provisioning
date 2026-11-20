import { randomUUID } from 'node:crypto';
import { Connection } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OWNER_ATTRIBUTE } from './workflow-owner.js';
import { readyNamespace } from './temporal-client.js';

let connection: Connection;
const made: string[] = [];

beforeAll(async () => { connection = await Connection.connect({ address: inject('temporalAddress') }); });
afterAll(async () => {
  for (const namespace of made) await connection.operatorService.deleteNamespace({ namespace });
  await connection.close();
});

describe('a Koala readying its Temporal namespace, as a plain Temporal server makes none', () => {
  it('registers its namespace when the server has none, with the owner search attribute, and is a no-op the second time', async () => {
    const namespace = `koala-ready-${randomUUID()}`;
    made.push(namespace);
    await readyNamespace(connection, namespace);
    await readyNamespace(connection, namespace);
    const described = await connection.workflowService.describeNamespace({ namespace });
    expect(described.namespaceInfo?.name).toBe(namespace);
    const attributes = await connection.operatorService.listSearchAttributes({ namespace });
    expect(Object.keys(attributes.customAttributes ?? {})).toContain(OWNER_ATTRIBUTE.name);
  });
});
