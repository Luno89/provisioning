import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { DependencyStates } from '../services/DependencyStates.js';
import { answersHttp, checkServices } from './dependencies.js';
import { resolveWebTools } from '../../engine/lib/web-tools-resolver.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });

async function serving(status: () => number): Promise<string> {
  const server = http.createServer((_req, res) => {
    const answer = status();
    res.writeHead(answer, { 'retry-after': '7', 'content-type': 'application/json' });
    res.end(answer === 200 ? JSON.stringify({ results: [{ title: 'Koalas', content: 'they sleep', url: 'https://koala.example' }] }) : '');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closing.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const quiet = () => undefined;

describe('checking a dependency over HTTP', () => {
  it('takes any answer as answering, a 5xx as temporary with Retry-After, and a closed port as refused', async () => {
    let status = 401;
    const base = await serving(() => status);
    await answersHttp(`${base}/v2/`)();
    status = 503;
    await expect(answersHttp(`${base}/api/healthz`)()).rejects.toMatchObject({ status: 503, retryAfter: '7' });
    await expect(answersHttp(`http://127.0.0.1:${await portToHandOn()}/health`)()).rejects.toThrow('fetch failed');
  });

  it('checks each service at its own path, and brings one back once it answers', async () => {
    let status = 503;
    const base = await serving(() => status);
    const states = new DependencyStates({ process: 'worker-cluster', described: ['gitea', 'infisical'], firstMs: 50, log: quiet });
    closing.push(async () => { states.stop(); });
    checkServices(states, { gitea: base, infisical: `${base}/` });
    await states.start();
    expect(states.down().map((down) => [down.dependency, down.reason])).toEqual([
      ['gitea', 'it answered 503, asking to be asked again after 7'],
      ['infisical', 'it answered 503, asking to be asked again after 7'],
    ]);
    status = 200;
    for (;;) {
      if (!states.down().length) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(states.stateOf('gitea')).toEqual({ state: 'answering' });
  });
});

describe('web search at the platform\'s SearXNG', () => {
  it('reports SearXNG failing and answering from the searches themselves, saying why search is down while it is', async () => {
    let status = 502;
    const searxng = await serving(() => status);
    const states = new DependencyStates({ process: 'worker-engine', described: ['searxng'], log: quiet });
    closing.push(async () => { states.stop(); });
    const offline: typeof fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    const tools = await resolveWebTools({
      db: { getDeployments: async () => [] },
      serviceUrl: async () => { throw new Error('no deployment is asked for'); },
      settings: { searxngUrl: searxng },
      dependencies: states,
      baseFetch: (input, init) => (String(input).startsWith(searxng) ? fetch(input, init) : offline(input, init)),
    });
    expect(tools.sources.search).toBe('searxng');
    expect(await tools.search('koala')).toEqual({ hits: [], unavailable: true, reason: 'SearXNG answered 502' });
    expect(states.stateOf('searxng')).toMatchObject({ state: 'down', reason: 'it answered 502, asking to be asked again after 7' });
    status = 200;
    expect(await tools.search('koala')).toMatchObject({ unavailable: false, hits: [{ url: 'https://koala.example' }] });
    expect(states.stateOf('searxng')).toEqual({ state: 'answering' });
  });
});
