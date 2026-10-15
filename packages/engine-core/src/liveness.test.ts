import { describe, it, expect } from 'vitest';
import { heartbeatWhileRunning } from './liveness.js';

describe('an activity says it is alive while it runs', () => {
  it('beats as it starts and on every interval until it ends, then stops', async () => {
    let beats = 0;
    const { inbound } = heartbeatWhileRunning(10)({ heartbeat: () => { beats += 1; } });
    const result = await inbound.execute({ args: [] }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 55));
      return 'done';
    });
    const atEnd = beats;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(result).toBe('done');
    expect(atEnd).toBeGreaterThanOrEqual(4);
    expect(beats).toBe(atEnd);
  });

  it('stops beating when the activity fails, and lets the failure through', async () => {
    let beats = 0;
    const { inbound } = heartbeatWhileRunning(10)({ heartbeat: () => { beats += 1; } });
    await expect(inbound.execute({ args: [] }, async () => { throw new Error('broke'); })).rejects.toThrow('broke');
    const atEnd = beats;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats).toBe(atEnd);
  });

  it('keeps the activity running when a beat cannot be sent', async () => {
    const { inbound } = heartbeatWhileRunning(5)({ heartbeat: () => { throw new Error('not in an activity'); } });
    await expect(inbound.execute({ args: [] }, async () => 'fine')).resolves.toBe('fine');
  });
});
