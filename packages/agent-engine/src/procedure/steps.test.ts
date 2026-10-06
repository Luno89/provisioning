import { describe, it, expect } from 'vitest';
import { collectStep, STEP_DIGEST_CHARS, type RunStep } from './values.js';

describe('a run\'s steps', () => {
  it('adds a step for each call and settles it with its result, nesting what a hand-off\'s run did', () => {
    const child = { runId: 'r-research-1', agentId: 'research', outcome: 'ok', steps: [{ callId: 'x', name: 'search_web', ok: true }] };
    let steps: RunStep[] = [];
    steps = collectStep(steps, { type: 'tool.called', callId: 'a', name: 'read_file' });
    steps = collectStep(steps, { type: 'tool.called', callId: 'b', name: 'research' });
    steps = collectStep(steps, { type: 'tool.called', callId: 'a', name: 'read_file' });
    steps = collectStep(steps, { type: 'tool.result', callId: 'b', ok: true, digest: 'found it', child });
    steps = collectStep(steps, { type: 'content', callId: 'b' });

    expect(steps).toEqual([
      { callId: 'a', name: 'read_file' },
      { callId: 'b', name: 'research', ok: true, digest: 'found it', child },
    ]);
  });

  it('keeps a digest short enough to store with the conversation', () => {
    const steps = collectStep([{ callId: 'a', name: 'fetch_web_page' }], { type: 'tool.result', callId: 'a', ok: false, digest: 'x'.repeat(5000) });

    expect(steps[0]).toMatchObject({ ok: false });
    expect(steps[0]!.digest).toHaveLength(STEP_DIGEST_CHARS);
  });
});
