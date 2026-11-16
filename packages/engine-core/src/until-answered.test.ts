import { describe, expect, it } from 'vitest';
import { reopening, untilAnswered } from './reopening.js';

const lost = (): Error => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3002'), { code: 'ECONNREFUSED' }) });

describe('asking a dependency until it answers', () => {
  it('waits out a lost connection and a busy answer, saying why each time, and hands back the answer it gets', async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => { throw lost(); },
      async () => new Response('busy', { status: 503 }),
      async () => new Response('ok', { status: 200 }),
    ];
    const heard: string[] = [];
    const answer = await untilAnswered(() => answers.shift()!(), reopening(1), (why, seconds) => heard.push(`${why} / ${seconds}`));
    expect(answer.status).toBe(200);
    expect(heard).toEqual(['it refused the connection (ECONNREFUSED) / 0', 'it answered 503 / 0']);
  });

  it('hands back a refusal for the caller to say, and throws a failure that will not change', async () => {
    expect((await untilAnswered(async () => new Response('no such instance', { status: 401 }), reopening(1), () => undefined)).status).toBe(401);
    await expect(untilAnswered(async () => { throw new Error('the request was malformed'); }, reopening(1), () => undefined)).rejects.toThrow('the request was malformed');
  });
});
