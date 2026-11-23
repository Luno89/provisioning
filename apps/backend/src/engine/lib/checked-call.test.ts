import { describe, it, expect, vi } from 'vitest';
import { checkedCall } from './checked-call.js';

describe('a checked tool call', () => {
  it('runs nothing when the checks refuse it, and hands back the refusal', async () => {
    const run = vi.fn(async () => ({ ok: true, digest: 'ran' }));
    const shown = vi.fn(async (outcome: { ok: boolean; digest: string }) => outcome);
    const outcome = await checkedCall({ check: async () => ({ refused: { ok: false, digest: 'refused' } }), run, shown });
    expect(outcome).toEqual({ ok: false, digest: 'refused' });
    expect(run).not.toHaveBeenCalled();
    expect(shown).not.toHaveBeenCalled();
  });

  it('runs what the checks let through and hands the model only what is shown of its result', async () => {
    const outcome = await checkedCall({
      check: async () => ({ ready: 'call-1' }),
      run: async (ready: string) => ({ ok: true, digest: `ran ${ready}\u{E0041}` }),
      shown: async (ran) => ({ ...ran, digest: ran.digest.replace('\u{E0041}', '') }),
    });
    expect(outcome).toEqual({ ok: true, digest: 'ran call-1' });
  });
});
