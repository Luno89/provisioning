import { describe, expect, it, vi } from 'vitest';
import { connectAgainIfRefused, keepTokenFresh, koalaSocket, whenRootNamesKoala, type KoalaAccess } from './koala-access.js';

const opened = vi.hoisted(() => ({ auth: [] as Array<(answer: (data: Record<string, unknown>) => void) => void> }));
vi.mock('socket.io-client', () => ({
  io: (_url: string, options: { auth: (answer: (data: Record<string, unknown>) => void) => void }) => {
    opened.auth.push(options.auth);
    return { emit: () => undefined };
  },
}));

const RESOURCE = 'urn:koala:instance:inst-1';

function world(answers: Array<string | Error>) {
  let now = 1_000;
  let renewsAt: number | undefined = 61_000;
  const waits: Array<{ ms: number; then: () => void; cancelled: boolean }> = [];
  const applied: string[] = [];
  const said: string[] = [];
  const asked: string[] = [];
  const access: KoalaAccess = {
    token: async (resource) => {
      asked.push(resource);
      const answer = answers.shift();
      if (!answer) throw new Error('the test gave no more tokens');
      if (answer instanceof Error) throw answer;
      renewsAt = now + 60_000;
      return answer;
    },
    freshToken: async () => { throw new Error('not asked here'); },
    renewsAt: (resource) => (resource === RESOURCE ? renewsAt : undefined),
  };
  const fresh = () => keepTokenFresh({
    access,
    resource: RESOURCE,
    apply: async (token) => { applied.push(token); },
    say: (line) => said.push(line),
    now: () => now,
    after: (ms, then) => {
      const wait = { ms, then, cancelled: false };
      waits.push(wait);
      return () => { wait.cancelled = true; };
    },
  });
  const settle = () => new Promise<void>((done) => { setImmediate(done); });
  const elapse = async () => {
    const wait = waits.at(-1)!;
    now += wait.ms;
    wait.then();
    await settle();
  };
  const held = (at: number | undefined) => { renewsAt = at; };
  return { fresh, held, waits, applied, said, asked, elapse };
}

describe('a machine keeping its token for its Koala fresh', () => {
  it('takes a fresh token when the one it holds is due, hands it on, and does the same when that one is due', async () => {
    const machine = world(['access-2', 'access-3']);
    machine.fresh();
    expect(machine.waits.map((wait) => wait.ms)).toEqual([60_000]);
    await machine.elapse();
    expect(machine.applied).toEqual(['access-2']);
    expect(machine.waits.map((wait) => wait.ms)).toEqual([60_000, 60_000]);
    await machine.elapse();
    expect(machine.applied).toEqual(['access-2', 'access-3']);
    expect(machine.asked).toEqual([RESOURCE, RESOURCE]);
    expect(machine.said).toEqual([]);
  });

  it('says why when root gives it no fresh token, and asks no more', async () => {
    const machine = world([new Error('invalid_client')]);
    machine.fresh();
    await machine.elapse();
    expect(machine.applied).toEqual([]);
    expect(machine.said).toEqual(['this machine could not take a fresh token for its Koala from root (invalid_client); its Koala\'s Temporal stops taking its calls once the one it holds ends, and it takes a fresh one as it starts its work again']);
    expect(machine.waits).toHaveLength(1);
  });

  it('says so, waiting on nothing, when it holds no token for its Koala to keep fresh', () => {
    const machine = world([]);
    machine.held(undefined);
    machine.fresh();
    expect(machine.waits).toEqual([]);
    expect(machine.said).toEqual(['this machine holds no token for its Koala to keep fresh; it takes one as it starts its work again']);
  });

  it('stops renewing once stopped', async () => {
    const machine = world(['access-2']);
    const stop = machine.fresh();
    stop();
    expect(machine.waits[0]!.cancelled).toBe(true);
  });
});

describe('a machine connecting to its Koala', () => {
  it('connects with only its own details, no token, when root cannot give it one', async () => {
    const access: KoalaAccess = { token: async () => 'held', freshToken: async () => { throw new Error('unexpected HTTP response status code'); }, renewsAt: () => undefined };
    koalaSocket({ url: 'http://koala.test', resource: RESOURCE, access, auth: { bundle: 'b1' }, say: () => undefined });
    const answered = await new Promise<Record<string, unknown>>((done) => opened.auth.at(-1)!(done));
    expect(answered).toEqual({ bundle: 'b1' });
  });

  it('asks its Koala again only when its Koala refused it and it has stopped trying', () => {
    const connects: string[] = [];
    const socket = (active: boolean) => ({ active, connect: () => { connects.push(active ? 'active' : 'refused'); return undefined as never; } });
    expect(connectAgainIfRefused(socket(true))).toBe(false);
    expect(connectAgainIfRefused(socket(false))).toBe(true);
    expect(connects).toEqual(['refused']);
  });
});

describe('root naming this machine\'s Koala', () => {
  it('starts the work the first time, asks the same Koala again when root names it again, and says it moved when root names another', () => {
    expect(whenRootNamesKoala(undefined, 'http://koala.test')).toBe('start');
    expect(whenRootNamesKoala({ url: 'http://koala.test' }, 'http://koala.test')).toBe('again');
    expect(whenRootNamesKoala({ url: 'http://koala.test' }, 'http://elsewhere.test')).toBe('moved');
  });
});
