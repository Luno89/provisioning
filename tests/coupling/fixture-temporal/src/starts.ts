import type { WorkflowClient } from '@temporalio/client';
import { DemoWorkflow } from './workflows/index.js';

const OTHER = 'OtherWorkflow';
type Named = 'DemoWorkflow' | 'OtherWorkflow';
const options = { taskQueue: 'q', workflowId: 'w' };

export async function byName(client: WorkflowClient): Promise<void> {
  await client.start('DemoWorkflow', options);
}

export async function byConstant(client: WorkflowClient): Promise<void> {
  await client.start(OTHER, options);
}

export async function byFunction(client: WorkflowClient): Promise<void> {
  await client.start(DemoWorkflow, { ...options, args: ['a'] });
}

export async function byUnion(client: WorkflowClient, picked: Named): Promise<void> {
  await client.start(picked, options);
}

export async function byAnyName(client: WorkflowClient, picked: string): Promise<void> {
  await client.start(picked, options);
}

export function notTemporal(list: { start: (name: string) => void }): void {
  list.start('DemoWorkflow');
}
