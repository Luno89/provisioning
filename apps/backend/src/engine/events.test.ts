import { describe, it, expect, vi } from 'vitest';
import { createEventBus, type EngineEvent } from './events.js';

const evt = (n: number): EngineEvent => ({
  type: 'content',
  runId: 'run-1',
  at: new Date(n).toISOString(),
  nodeId: 'node-1',
  delta: `d${n}`,
});

describe('createEventBus', () => {
  it('delivers events to every subscriber', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.emit(evt(1));

    expect(a).toHaveBeenCalledWith(evt(1));
    expect(b).toHaveBeenCalledWith(evt(1));
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus();
    const seen = vi.fn();
    const off = bus.subscribe(seen);

    bus.emit(evt(1));
    off();
    bus.emit(evt(2));

    expect(seen).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('isolates a throwing subscriber so the run and other subscribers survive', () => {
    const onSubscriberError = vi.fn();
    const bus = createEventBus({ onSubscriberError });
    const healthy = vi.fn();

    bus.subscribe(() => { throw new Error('sink exploded'); });
    bus.subscribe(healthy);

    expect(() => bus.emit(evt(1))).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(evt(1));
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
  });

  it('replays retained events to a subscriber that attaches mid-run', () => {
    const bus = createEventBus();
    bus.emit(evt(1));
    bus.emit(evt(2));

    const late = vi.fn();
    bus.subscribe(late, { replay: true });

    expect(late.mock.calls.map(([e]) => (e as { delta: string }).delta)).toEqual(['d1', 'd2']);

    bus.emit(evt(3));
    expect(late).toHaveBeenCalledTimes(3);
  });

  it('does not replay unless asked', () => {
    const bus = createEventBus();
    bus.emit(evt(1));

    const late = vi.fn();
    bus.subscribe(late);

    expect(late).not.toHaveBeenCalled();
  });

  it('drops the oldest events once the retention cap is exceeded', () => {
    const bus = createEventBus({ retain: 2 });
    bus.emit(evt(1));
    bus.emit(evt(2));
    bus.emit(evt(3));

    expect(bus.retained().map((e) => (e as { delta: string }).delta)).toEqual(['d2', 'd3']);
  });

  it('retains nothing when retention is disabled', () => {
    const bus = createEventBus({ retain: 0 });
    bus.emit(evt(1));
    expect(bus.retained()).toEqual([]);
  });
});
