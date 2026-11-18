import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadChecked } from './download.js';

const BODY = 'k3s binary bytes\n';
const SHA = createHash('sha256').update(BODY).digest('hex');
const answering = (response: () => Response): typeof fetch => (async () => response()) as unknown as typeof fetch;
const place = () => path.join(mkdtempSync(path.join(tmpdir(), 'koala-download-')), 'k3s');

describe('downloadChecked', () => {
  it('keeps the file when its sha256 is the one pinned', async () => {
    const to = place();
    await downloadChecked({ what: 'k3s v1', url: 'https://example.test/k3s', to, sha256: SHA, fetcher: answering(() => new Response(BODY)) });
    expect(readFileSync(to, 'utf8')).toBe(BODY);
  });

  it('removes the file and says so when its sha256 is not the one pinned', async () => {
    const to = place();
    await expect(downloadChecked({ what: 'k3s v1', url: 'https://example.test/k3s', to, sha256: '0'.repeat(64), fetcher: answering(() => new Response(BODY)) }))
      .rejects.toThrow('k3s v1 from https://example.test/k3s is not the one Koala pins (its sha256 differs); nothing was installed');
    expect(existsSync(to)).toBe(false);
  });

  it('says what the server answered when it does not send the file', async () => {
    await expect(downloadChecked({ what: 'helm', url: 'https://example.test/helm', to: place(), sha256: SHA, fetcher: answering(() => new Response('gone', { status: 404 })) }))
      .rejects.toThrow('helm could not be downloaded: https://example.test/helm answered 404');
  });

  it('says why when the server cannot be reached', async () => {
    const unreachable = (async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND example.test') }); }) as unknown as typeof fetch;
    await expect(downloadChecked({ what: 'helm', url: 'https://example.test/helm', to: place(), sha256: SHA, fetcher: unreachable }))
      .rejects.toThrow('helm could not be downloaded from https://example.test/helm: fetch failed (getaddrinfo ENOTFOUND example.test)');
  });
});
