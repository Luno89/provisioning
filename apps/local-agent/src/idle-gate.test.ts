import { describe, expect, it } from 'vitest';
import { IdleGate, holding } from './idle-gate.js';

describe('a machine is idle when nothing runs on it', () => {
  it('is idle with no holds, and busy while any is held', () => {
    const gate = new IdleGate();
    expect(gate.idle).toBe(true);
    const step = gate.hold('a tool call');
    const session = gate.hold('a session of gemini');
    expect(gate.idle).toBe(false);
    expect(gate.busyWith()).toEqual(['a session of gemini', 'a tool call']);
    step();
    expect(gate.idle).toBe(false);
    session();
    expect(gate.idle).toBe(true);
  });

  it('counts the same kind of work, and a release given twice lets go once', () => {
    const gate = new IdleGate();
    const one = gate.hold('a command');
    gate.hold('a command');
    expect(gate.busyWith()).toEqual(['2 × a command']);
    one();
    one();
    expect(gate.busyWith()).toEqual(['a command']);
  });

  it('wakes whoever waits at the moment the last hold is let go, and not before', async () => {
    const gate = new IdleGate();
    await gate.whenIdle();
    const first = gate.hold('a command');
    const second = gate.hold('a tool call');
    let woken = false;
    const waited = gate.whenIdle().then(() => { woken = true; });
    first();
    await Promise.resolve();
    expect(woken).toBe(false);
    second();
    await waited;
    expect(woken).toBe(true);
  });

  it('holds for as long as the work runs, however it ends', async () => {
    const gate = new IdleGate();
    let finish: () => void = () => {};
    const running = holding(gate, 'a command', () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(gate.idle).toBe(false);
    finish();
    await running;
    expect(gate.idle).toBe(true);
    await expect(holding(gate, 'a command', () => Promise.reject(new Error('it failed')))).rejects.toThrow('it failed');
    expect(gate.idle).toBe(true);
  });
});
