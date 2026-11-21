import { describe, it, expect } from 'vitest';
import * as workflows from './index.js';
import { DELETE_PROJECT_WORKFLOW } from '../projects/lib/project-removal.js';
import { PURGE_PROJECT_WORKFLOW } from '../projects/lib/project-archive.js';

describe('the workflow bundle workers load', () => {
  it('exports every workflow the app starts by name', () => {
    for (const name of ['AgentRunWorkflow', 'executeIngestWorkflow', 'executePipelineRunWorkflow', 'AdoptPlanWorkflow', DELETE_PROJECT_WORKFLOW, PURGE_PROJECT_WORKFLOW]) {
      expect(typeof (workflows as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
