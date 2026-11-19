import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() => ({ clients: [] as Array<{ uri: string; options: unknown; closed: number; failConnect?: Error }>, failNext: undefined as Error | undefined }));

vi.mock('mongodb', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class MongoClient extends Emitter {
    readonly made: { uri: string; options: unknown; closed: number; failConnect?: Error };
    constructor(uri: string, options: unknown) {
      super();
      this.made = { uri, options, closed: 0, ...(made.failNext ? { failConnect: made.failNext } : {}) };
      made.failNext = undefined;
      made.clients.push(this.made);
    }
    async connect() { if (this.made.failConnect) throw this.made.failConnect; return this; }
    async close() { this.made.closed += 1; }
    db() { return { command: async () => ({ setName: 'rs0', isWritablePrimary: true }) }; }
  }
  return { MongoClient };
});

const { leaseMongo } = await import('./mongo-lease.js');

describe('the one Mongo connection a process keeps', () => {
  beforeEach(() => { made.clients.length = 0; });

  it('is made once, with the options Koala connects with, however many parts ask for it', async () => {
    const one = await leaseMongo('mongodb://127.0.0.1:27017/koala');
    const two = await leaseMongo('mongodb://127.0.0.1:27017/koala');
    expect(made.clients).toEqual([{ uri: 'mongodb://127.0.0.1:27017/koala', options: { ignoreUndefined: true, directConnection: true }, closed: 0 }]);
    await one.release();
    expect(made.clients[0]!.closed).toBe(0);
    await two.release();
    expect(made.clients[0]!.closed).toBe(1);
  });

  it('tells every part\'s dependency reporter how Mongo answers', async () => {
    const heard: string[] = [];
    const reporter = (name: string) => ({ failed: () => { heard.push(`${name} failed`); }, answered: () => { heard.push(`${name} answered`); } });
    const one = await leaseMongo('mongodb://127.0.0.1:27017/koala', [reporter('backend')]);
    const two = await leaseMongo('mongodb://127.0.0.1:27017/koala', [reporter('hub')]);
    (one.client as unknown as EventEmitter).emit('serverHeartbeatSucceeded', {});
    expect(heard).toEqual(['backend answered', 'hub answered']);
    await one.release();
    await two.release();
  });

  it('keeps nothing of a Mongo it could not reach, so the next ask connects again', async () => {
    made.failNext = new Error('connect ECONNREFUSED 127.0.0.1:27017');
    await expect(leaseMongo('mongodb://127.0.0.1:27017/koala')).rejects.toThrow('ECONNREFUSED');
    expect(made.clients[0]!.closed).toBe(1);
    const later = await leaseMongo('mongodb://127.0.0.1:27017/koala');
    expect(made.clients).toHaveLength(2);
    await later.release();
  });

  it('refuses a lease let go of twice, rather than closing the connection under another part', async () => {
    const one = await leaseMongo('mongodb://127.0.0.1:27017/koala');
    const two = await leaseMongo('mongodb://127.0.0.1:27017/koala');
    await one.release();
    await expect(one.release()).rejects.toThrow('this hold on Mongo was already let go of');
    expect(made.clients[0]!.closed).toBe(0);
    await two.release();
  });
});
