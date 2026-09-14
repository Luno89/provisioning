import { describe, it, expect, vi } from 'vitest';
import { createBrowserBus, ENGINE_EVENT_CHANNEL } from './stream-worker.js';
import type { EngineEvent } from '../events.js';

const event = (over: Partial<EngineEvent> = {}): EngineEvent => ({
  type: 'thinking',
  runId: 'run-1',
  at: '2026-01-01T00:00:00.000Z',
  nodeId: 'think',
  delta: 'weighing it up',
  ...over,
} as EngineEvent);

describe('browser bus', () => {
  it('pushes every engine event out to connected browsers', () => {
    const io = { emit: vi.fn() };
    const bus = createBrowserBus(io);

    bus.emit(event());

    expect(io.emit).toHaveBeenCalledWith(ENGINE_EVENT_CHANNEL, event());
  });

  it('streams thinking deltas as they arrive rather than batching them', () => {
    const io = { emit: vi.fn() };
    const bus = createBrowserBus(io);

    bus.emit(event({ delta: 'first' }));
    bus.emit(event({ delta: 'second' }));
    bus.emit(event({ delta: 'third' }));

    expect(io.emit).toHaveBeenCalledTimes(3);
    expect(io.emit.mock.calls.map(([, e]) => (e as { delta: string }).delta))
      .toEqual(['first', 'second', 'third']);
  });

  it('can be pointed at a different channel', () => {
    const io = { emit: vi.fn() };
    createBrowserBus(io, 'custom-channel').emit(event());

    expect(io.emit).toHaveBeenCalledWith('custom-channel', expect.anything());
  });

  it('retains recent events so a browser attaching mid-run can catch up', () => {
    const io = { emit: vi.fn() };
    const bus = createBrowserBus(io);

    bus.emit(event({ delta: 'already happened' }));

    const late = vi.fn();
    bus.subscribe(late, { replay: true });

    expect(late).toHaveBeenCalledTimes(1);
    expect(bus.retained()).toHaveLength(1);
  });

  it('keeps streaming when a socket emit throws', () => {
    const io = {
      emit: vi.fn(() => { throw new Error('socket went away'); }),
    };
    const bus = createBrowserBus(io);

    expect(() => bus.emit(event())).not.toThrow();
  });
});
