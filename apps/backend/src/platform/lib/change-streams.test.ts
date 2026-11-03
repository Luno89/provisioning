import { EventEmitter } from 'node:events';
import type { Collection } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchingAll, watchWrites } from './change-streams.js';

interface FakeStream extends EventEmitter { closed: number; close(): Promise<void> }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function watched() {
  const streams: FakeStream[] = [];
  const opened: unknown[] = [];
  const collection = {
    collectionName: 'deployments',
    watch: (pipeline: unknown, options: unknown) => {
      opened.push({ pipeline, options });
      const stream = Object.assign(new EventEmitter(), { closed: 0, async close() { stream.closed += 1; } }) as FakeStream;
      streams.push(stream);
      return stream;
    },
  } as unknown as Collection<{ id: string }>;
  return { collection, streams, opened };
}

describe('following writes to a collection', () => {
  it('is ready once the stream answers, hands over each written record, and opens again after the last token when the stream fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collection, streams, opened } = watched();
    const heard: string[] = [];
    const watching = watchWrites(() => collection, { status: 'deploying' }, (doc) => heard.push(doc.id), 1_000);
    expect(opened).toEqual([{ pipeline: [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] }, 'fullDocument.status': 'deploying' } }], options: { fullDocument: 'updateLookup' } }]);
    streams[0]!.emit('resumeTokenChanged', { _data: 't1' });
    await watching.ready;
    streams[0]!.emit('change', { operationType: 'insert', fullDocument: { id: 'shop' } });
    streams[0]!.emit('change', { operationType: 'delete' });
    expect(heard).toEqual(['shop']);

    streams[0]!.emit('error', new Error('connection reset'));
    expect(streams[0]!.closed).toBe(1);
    expect(warn).toHaveBeenCalledWith('[change-streams] following deployments stopped (connection reset); opening it again in 1 s');
    await vi.advanceTimersByTimeAsync(999);
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened[1]).toMatchObject({ options: { fullDocument: 'updateLookup', startAfter: { _data: 't1' } } });

    await watching.close();
    expect(streams[1]!.closed).toBe(1);
    streams[1]!.emit('error', new Error('after close'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened).toHaveLength(2);
  });

  it('is ready when every one of several is', async () => {
    const one = watched();
    const two = watched();
    const both = watchingAll([watchWrites(() => one.collection, {}, () => undefined), watchWrites(() => two.collection, {}, () => undefined)]);
    let ready = false;
    void both.ready.then(() => { ready = true; });
    one.streams[0]!.emit('resumeTokenChanged', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    two.streams[0]!.emit('resumeTokenChanged', {});
    await both.ready;
    await both.close();
    expect([one.streams[0]!.closed, two.streams[0]!.closed]).toEqual([1, 1]);
  });
});
