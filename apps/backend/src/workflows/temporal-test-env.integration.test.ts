import { Connection } from '@temporalio/client';
import { createClient } from '@koala/engine-core/temporal';
import { testPayloads } from '@koala/engine-core/testing/temporal';
import { describe, expect, inject, it } from 'vitest';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { freshNamespace } from './testing/temporal-test-env.js';

describe('a Temporal namespace for one test file', () => {
  it('is new, takes a workflow with Koala\'s owner attribute at once, is no other file\'s, and is gone once dropped', async () => {
    const first = await freshNamespace();
    const second = await freshNamespace();
    expect(first.namespace).not.toBe(second.namespace);
    const connection = await Connection.connect({ address: inject('temporalAddress') });
    const payloads = testPayloads();
    const client = createClient({ connection, namespace: first.namespace, payloads });
    await client.workflow.start('nothing', { taskQueue: 'nowhere', workflowId: 'owned', args: [], ...startedFor('bo') });
    const listed = createClient({ connection, namespace: second.namespace, payloads }).workflow.list();
    const elsewhere: string[] = [];
    for await (const run of listed) elsewhere.push(run.workflowId);
    expect(elsewhere).toEqual([]);
    await first.drop();
    await second.drop();
    const known = (await connection.workflowService.listNamespaces({})).namespaces.map((entry) => entry.namespaceInfo?.name);
    expect(known).not.toContain(first.namespace);
    await connection.close();
  });
});
