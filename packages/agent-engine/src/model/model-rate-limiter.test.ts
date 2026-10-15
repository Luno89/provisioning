import { describe, it, expect } from 'vitest';
import { acquireModelSlot, rateLimitedFetch } from './model-rate-limiter.js';

describe('waiting for a model', () => {
  it('waits for the call ahead of it however long that takes, with no deadline of its own', async () => {
    const release = await acquireModelSlot('slow-endpoint', 'bo', 'slow');
    let got = false;
    const waiting = acquireModelSlot('slow-endpoint', 'bo', 'slow').then((next) => { got = true; return next; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toBe(false);

    release();
    (await waiting)();
    expect(got).toBe(true);
  });

  it('leaves the line when its run is stopped, and the next one in line still gets the slot', async () => {
    const release = await acquireModelSlot('busy-endpoint', 'bo', 'busy');
    const stop = new AbortController();
    const stopped = acquireModelSlot('busy-endpoint', 'bo', 'busy', stop.signal);
    const next = acquireModelSlot('busy-endpoint', 'bo', 'busy');

    stop.abort('the run was stopped');
    await expect(stopped).rejects.toThrow('the run was stopped');
    release();
    (await next)();
  });

  it('hands the stop to the queue from the request it was given', async () => {
    const release = await acquireModelSlot('fetching-endpoint', 'bo', 'fetching');
    const stop = new AbortController();
    const called: string[] = [];
    const doFetch = rateLimitedFetch('fetching-endpoint', 'bo', 'fetching', (async (input: string) => { called.push(input); return new Response('{}'); }) as unknown as typeof fetch);

    const waiting = doFetch('http://model/v1/chat/completions', { signal: stop.signal });
    stop.abort('stopped');
    await expect(waiting).rejects.toThrow('stopped');
    expect(called).toEqual([]);
    release();
  });
});
