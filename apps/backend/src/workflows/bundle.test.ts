import { describe, expect, it } from 'vitest';
import { bundled } from './testing/temporal-test-env.js';

describe('the workflows Temporal runs', () => {
  it('bundle, every module they reach being pure code with nothing of Node in it', async () => {
    const bundle = await bundled(import.meta.dirname);
    expect(bundle.code).toContain('AgentRunWorkflow');
  });
});
