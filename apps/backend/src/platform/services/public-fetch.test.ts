import dns from 'node:dns';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interceptHttp } from '../testing/http.js';
import { NotPublicError, publicAddressProblem, publicFetch } from './public-fetch.js';

type Lookup = (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => void;

const agent = vi.hoisted(() => ({ lookup: undefined as Lookup | undefined }));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: { connect: { lookup: Lookup } }) {
        super();
        agent.lookup = options.connect.lookup;
      }
    },
  };
});

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, default: { ...actual, lookup: vi.fn(), promises: { ...actual.promises, lookup: vi.fn() } } };
});

const resolves = (...addresses: string[]) => vi.mocked(dns.promises.lookup).mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never);

let reached: string[] = [];
interceptHttp(
  http.get('https://public.example.test/page', () => { reached.push('page'); return HttpResponse.text('hello'); }),
  http.get('https://public.example.test/old', () => new HttpResponse(null, { status: 302, headers: { location: '/page' } })),
  http.get('https://public.example.test/loop', () => new HttpResponse(null, { status: 302, headers: { location: '/loop' } })),
  http.get('https://public.example.test/inside', () => new HttpResponse(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })),
  http.get('https://public.example.test/elsewhere', () => new HttpResponse(null, { status: 301, headers: { location: 'https://other.example.test/landed' } })),
  http.get('https://other.example.test/landed', () => HttpResponse.text('landed')),
);

beforeEach(() => {
  reached = [];
  vi.mocked(dns.promises.lookup).mockReset();
  vi.mocked(dns.lookup).mockReset();
});

describe('fetching from the open internet', () => {
  it('never reaches this machine or the private network, by address', async () => {
    await expect(publicFetch('http://127.0.0.1:8080/')).rejects.toThrow(NotPublicError);
    await expect(publicFetch('http://[::1]/')).rejects.toThrow(NotPublicError);
    await expect(publicFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(NotPublicError);
    await expect(publicFetch('http://10.1.2.3/')).rejects.toThrow(NotPublicError);
    await expect(publicFetch('file:///etc/passwd')).rejects.toThrow(/file: is not http or https/);
    await expect(publicFetch('https://user:pw@public.example.test/page')).rejects.toThrow(/name and password/);
    expect(reached).toEqual([]);
  });

  it('fetches a public page, given as a string, an address or a request', async () => {
    expect(await (await publicFetch('https://public.example.test/page')).text()).toBe('hello');
    expect(await (await publicFetch(new URL('https://public.example.test/page'))).text()).toBe('hello');
    expect(await (await publicFetch(new Request('https://public.example.test/page'))).text()).toBe('hello');
  });

  it('follows a redirect to another public page, and refuses one to a private address', async () => {
    expect(await (await publicFetch('https://public.example.test/old')).text()).toBe('hello');
    expect(await (await publicFetch('https://public.example.test/elsewhere')).text()).toBe('landed');
    await expect(publicFetch('https://public.example.test/inside')).rejects.toThrow(NotPublicError);
  });

  it('gives up on a page that redirects forever', async () => {
    await expect(publicFetch('https://public.example.test/loop')).rejects.toThrow(/redirected more than 10 times/);
  });
});

describe('a name that resolves somewhere private', () => {
  const lookup = (hostname: string, all = false) => new Promise<{ err: Error | null; address: unknown; family?: number | undefined }>((done) => {
    agent.lookup?.(hostname, { all }, (err, address, family) => done({ err, address, family }));
  });

  it('is refused at connect time, saying what it resolves to', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _options: unknown, callback: (err: null, addresses: Array<{ address: string; family: number }>) => void) => {
      callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    }) as never);
    const { err } = await lookup('rebind.example.test');
    expect(err).toBeInstanceOf(NotPublicError);
    expect(err?.message).toMatch(/rebind\.example\.test resolves to .*private/i);
  });

  it('is refused when it resolves to nothing', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _options: unknown, callback: (err: null, addresses: never[]) => void) => { callback(null, []); }) as never);
    const { err } = await lookup('empty.example.test');
    expect(err?.message).toMatch(/empty\.example\.test resolves to nothing/);
  });

  it('passes the lookup\'s own failure on', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _options: unknown, callback: (err: Error) => void) => { callback(new Error('ENOTFOUND')); }) as never);
    expect((await lookup('missing.example.test')).err?.message).toBe('ENOTFOUND');
  });

  it('is handed a public address, one or all of them as the connection asks', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _options: unknown, callback: (err: null, addresses: Array<{ address: string; family: number }>) => void) => {
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    }) as never);
    expect(await lookup('fine.example.test')).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect(await lookup('fine.example.test', true)).toEqual({ err: null, address: [{ address: '93.184.216.34', family: 4 }], family: undefined });
  });
});

describe('saying why an address would be refused before anything is sent there', () => {
  it('refuses a name that resolves to a private address, and accepts one that resolves to a public one', async () => {
    resolves('127.0.0.1');
    expect(await publicAddressProblem('http://localhost:3001')).toMatch(/private|loopback|not a public/i);
    resolves('93.184.216.34');
    expect(await publicAddressProblem('https://example.test/')).toBeUndefined();
  });

  it('refuses a name when any of its addresses is private', async () => {
    resolves('93.184.216.34', '10.0.0.5');
    expect(await publicAddressProblem('https://mixed.example.test/')).toMatch(/private/i);
  });

  it('refuses a name that resolves to nothing or fails to resolve', async () => {
    resolves();
    expect(await publicAddressProblem('https://empty.example.test/')).toBe('empty.example.test resolves to nothing');
    vi.mocked(dns.promises.lookup).mockRejectedValue(new Error('ENOTFOUND'));
    expect(await publicAddressProblem('https://gone.example.test/')).toBe('gone.example.test resolves to nothing: ENOTFOUND');
  });

  it('judges an address given as numbers without asking DNS', async () => {
    expect(await publicAddressProblem('http://10.1.2.3/')).toMatch(/private/);
    expect(await publicAddressProblem('http://[fd00::1]/')).toBeDefined();
    expect(await publicAddressProblem('http://user:pw@93.184.216.34/')).toMatch(/name and password/);
    expect(await publicAddressProblem('http://93.184.216.34/')).toBeUndefined();
    expect(await publicAddressProblem('ftp://93.184.216.34/')).toMatch(/not http or https/);
    expect(await publicAddressProblem('not an address')).toBe('not an address is not an address');
    expect(dns.promises.lookup).not.toHaveBeenCalled();
  });
});
