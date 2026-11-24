import { describe, expect, it } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { reached, seen, type Watched } from './watched-page.js';

const pageAt = (at: () => string, closed = () => false): Page => ({ url: at, isClosed: closed }) as unknown as Page;
const shown = (visible: () => boolean): Locator => { const one = { isVisible: async () => visible() } as unknown as Locator; return { first: () => one } as unknown as Locator; };

describe('a wait on what a browser shows', () => {
  it('ends the moment the thing is on the page', async () => {
    let looks = 0;
    const watching: Watched = { page: pageAt(() => 'http://koala.test/#/chat'), problems: [] };
    await seen(watching, 'the answer', shown(() => { looks += 1; return looks > 1; }));
    expect(looks).toBe(2);
  });

  it('ends at once with why when the page reports a problem, closes, or the caller names a state it can never come back from', async () => {
    const hidden = shown(() => false);
    await expect(seen({ page: pageAt(() => 'http://koala.test/'), problems: ['500 GET /api/me'] }, 'the answer', hidden)).rejects.toThrow('the answer: the page reported 500 GET /api/me');
    await expect(seen({ page: pageAt(() => 'http://koala.test/', () => true), problems: [] }, 'the answer', hidden)).rejects.toThrow('the answer: the page closed');
    await expect(seen({ page: pageAt(() => 'http://koala.test/'), problems: [] }, 'the answer', hidden, async () => 'the instance stopped')).rejects.toThrow('the answer: the instance stopped');
  });

  it('follows the page to an address, and ends with why on a state it can never come back from', async () => {
    let at = 'http://instance.test/#/chat';
    const watching: Watched = { page: pageAt(() => at), problems: [] };
    const going = reached(watching, 'root', (url) => url.origin === 'http://root.test', async () => { at = 'http://root.test/oidc/session/end'; return undefined; });
    expect((await going).origin).toBe('http://root.test');
    await expect(reached({ page: pageAt(() => 'http://instance.test/#/chat'), problems: [] }, 'root', (url) => url.origin === 'http://root.test', async () => 'the browser is back on the instance, signed in')).rejects.toThrow('root: the browser is back on the instance, signed in');
  });
});
