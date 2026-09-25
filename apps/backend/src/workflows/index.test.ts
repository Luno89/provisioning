import { describe, it, expect } from 'vitest';
import * as workflows from './index.js';

describe('the workflow bundle workers load', () => {
  it('exports every workflow the app starts by name', () => {
    for (const name of ['AgentRunWorkflow', 'executeIngestWorkflow', 'ClusterProvisionWorkflow', 'LeafWorkflow', 'AdoptPlanWorkflow']) {
      expect(typeof (workflows as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
