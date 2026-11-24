import { describe, expect, it } from 'vitest';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { ContinueAsNew } from '@temporalio/workflow';
import { failedWorkflow } from './failure-reports.js';

describe('which endings of a workflow are reported as failed', () => {
  it('reports a workflow that failed, and never one that was cancelled, continued as new or threw something Temporal did not', () => {
    expect(failedWorkflow(ApplicationFailure.create({ message: 'the deploy could not start' }))).toBe(true);
    expect(failedWorkflow(new CancelledFailure('the person stopped it'))).toBe(false);
    expect(failedWorkflow(new ContinueAsNew({ workflowType: 'AgentRunWorkflow', arguments: [], taskQueue: 'engine', headers: {}, searchAttributes: {}, memo: {} } as never))).toBe(false);
    expect(failedWorkflow(new Error('not a Temporal failure'))).toBe(false);
  });
});
