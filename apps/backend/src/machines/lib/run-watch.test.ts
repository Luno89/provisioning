import { describe, expect, it } from 'vitest';
import { runIdsFrom } from './run-watch.js';

describe('the runs a machine says hold its sessions', () => {
  it('keeps run ids once each, and drops anything that is not one', () => {
    expect(runIdsFrom({ runIds: ['chat-1-koala-1', 'grove-run-t~mvv1-executor-2', 'chat-1-koala-1', 7, '', 'no spaces here', 'x'.repeat(301)] }))
      .toEqual(['chat-1-koala-1', 'grove-run-t~mvv1-executor-2']);
    expect(runIdsFrom({})).toEqual([]);
    expect(runIdsFrom('chat-1')).toEqual([]);
    expect(runIdsFrom({ runIds: Array.from({ length: 500 }, (_, n) => `run-${n}`) })).toHaveLength(200);
  });
});
