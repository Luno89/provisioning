import { describe, it, expect, vi, afterEach } from 'vitest';
import { patientFetch, PATIENT_DISPATCHER } from './patient-fetch.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('a fetch that waits as long as the other end takes', () => {
  it('goes out through the dispatcher with no header or body timeout, keeping everything else it was given', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => { seen.push(init); return new Response('ok'); });
    const stop = new AbortController();

    await patientFetch('http://model/v1/chat/completions', { method: 'POST', body: '{}', signal: stop.signal });

    expect(seen[0]).toMatchObject({ method: 'POST', body: '{}', signal: stop.signal, dispatcher: PATIENT_DISPATCHER });
  });
});
