import { describe, expect, it, vi } from 'vitest';
import * as client from 'openid-client';
import { answerUnlimited, withAnswerUnlimited } from './oidc-fetch.js';

describe('openid-client without its own limit on the answer', () => {
  it('drops the 30 s signal openid-client puts on each request and keeps everything else', async () => {
    const doFetch = vi.fn(async () => new Response('{}'));
    const theirs = AbortSignal.timeout(30_000);
    await answerUnlimited(doFetch as unknown as typeof fetch)('https://issuer.example/token', { method: 'POST', headers: { a: 'b' }, body: 'x', redirect: 'manual', signal: theirs });
    expect(doFetch).toHaveBeenCalledWith('https://issuer.example/token', { method: 'POST', headers: { a: 'b' }, body: 'x', redirect: 'manual' });
  });

  it('is handed to openid-client as its custom fetch', () => {
    expect(typeof withAnswerUnlimited()[client.customFetch]).toBe('function');
  });
});
