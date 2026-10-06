import { describe, it, expect, vi } from 'vitest';
import { createBrowserBus, ENGINE_EVENT_CHANNEL, userRoom } from './stream-worker.js';
import type { EngineEvent } from '@koala/agent-engine';

const event = (over: Partial<EngineEvent> & { ownerId?: string } = {}): EngineEvent => ({
  type: 'thinking',
  runId: 'run-1',
  at: '2026-01-01T00:00:00.000Z',
  nodeId: 'think',
  delta: 'weighing it up',
  ownerId: 'u1',
  ...over,
} as EngineEvent);

const rooms = () => {
  const sent: { room: string; channel: string; payload: unknown }[] = [];
  return {
    sent,
    io: { to: (room: string) => ({ emit: (channel: string, payload: unknown) => { sent.push({ room, channel, payload }); } }) },
  };
};

describe('browser bus', () => {
  it('sends each engine event to its owner\'s browsers only, without the owner on it', () => {
    const { io, sent } = rooms();
    const bus = createBrowserBus(io);

    bus.emit(event());
    bus.emit(event({ ownerId: 'u2', delta: 'someone else\'s' }));

    const { ownerId: _ownerId, ...plain } = event() as EngineEvent & { ownerId?: string };
    expect(sent).toEqual([
      { room: userRoom('u1'), channel: ENGINE_EVENT_CHANNEL, payload: plain },
      { room: userRoom('u2'), channel: ENGINE_EVENT_CHANNEL, payload: expect.objectContaining({ delta: 'someone else\'s' }) },
    ]);
  });

  it('sends an event that names no owner to nobody', () => {
    const { io, sent } = rooms();
    const { ownerId: _ownerId, ...ownerless } = event() as EngineEvent & { ownerId?: string };

    createBrowserBus(io).emit(ownerless as EngineEvent);

    expect(sent).toEqual([]);
  });

  it('streams thinking deltas as they arrive rather than batching them', () => {
    const { io, sent } = rooms();
    const bus = createBrowserBus(io);

    bus.emit(event({ delta: 'first' }));
    bus.emit(event({ delta: 'second' }));
    bus.emit(event({ delta: 'third' }));

    expect(sent.map(({ payload }) => (payload as { delta: string }).delta)).toEqual(['first', 'second', 'third']);
  });

  it('can be pointed at a different channel', () => {
    const { io, sent } = rooms();
    createBrowserBus(io, 'custom-channel').emit(event());

    expect(sent[0]?.channel).toBe('custom-channel');
  });

  it('retains recent events so a browser attaching mid-run can catch up', () => {
    const { io } = rooms();
    const bus = createBrowserBus(io);

    bus.emit(event({ delta: 'already happened' }));

    const late = vi.fn();
    bus.subscribe(late, { replay: true });

    expect(late).toHaveBeenCalledTimes(1);
    expect(bus.retained()).toHaveLength(1);
  });

  it('keeps streaming when a socket emit throws', () => {
    const io = { to: () => ({ emit: vi.fn(() => { throw new Error('socket went away'); }) }) };
    const bus = createBrowserBus(io);

    expect(() => bus.emit(event())).not.toThrow();
  });
});
