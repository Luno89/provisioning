import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { interceptHttp } from '../../platform/testing/http.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { DependencyWatch } from './DependencyWatch.js';

const npm = (name: string, version: string, extra: { name: string; value: string }[] = []) =>
  ({ 'bom-ref': `koala:pkg:npm/${name}@${version}`, name, version, properties: [{ name: 'koala:kind', value: 'npm' }, { name: 'koala:in', value: 'koala' }, ...extra] });

const k3s = { 'bom-ref': 'binary:pkg:generic/k3s@v1.36.4+k3s1', name: 'k3s', version: 'v1.36.4+k3s1', properties: [{ name: 'koala:kind', value: 'binary' }, { name: 'koala:osv-ecosystem', value: 'Go' }, { name: 'koala:osv-name', value: 'github.com/k3s-io/k3s' }, { name: 'koala:github', value: 'k3s-io/k3s' }, { name: 'koala:released', value: '2026-09-01T00:00:00Z' }] };
const mongo = { 'bom-ref': 'image:pkg:docker/library/mongo@7', name: 'mongo', version: '7', properties: [{ name: 'koala:kind', value: 'image' }, { name: 'koala:floating', value: 'true' }] };

const inventories: Record<string, unknown> = {
  aaaaaaaaaaaa: { components: [npm('seroval', '1.6.7'), npm('left-pad', '1.3.0'), k3s, mongo] },
  bbbbbbbbbbbb: { components: [npm('seroval', '1.6.11'), npm('left-pad', '1.3.0'), k3s, mongo] },
};

const advisory = (id: string, name: string, ecosystem: string, fixed: string, severity = 'HIGH') =>
  ({ id, summary: `${id} summary`, database_specific: { severity }, affected: [{ package: { ecosystem, name }, ranges: [{ events: [{ introduced: '0' }, { fixed }] }] }] });

const ADVISORIES: Record<string, unknown> = {
  'GHSA-seroval': advisory('GHSA-seroval', 'seroval', 'npm', '1.6.8'),
  'GO-k3s': advisory('GO-k3s', 'github.com/k3s-io/k3s', 'Go', '1.36.5+k3s1', 'CRITICAL'),
  'GHSA-xmldom': advisory('GHSA-xmldom', '@xmldom/xmldom', 'npm', '0.8.11'),
};

interface Asked { url: string; body?: string }

let asked: Asked[];
let seroval11At = '2026-10-18T00:00:00Z';
let osvStatus = 200;
let ghcrStatus = 200;
let tabbyLatest = 'b'.repeat(64);
let hub: { token: number; manifest: number; body?: unknown };

const VLLM_PINNED = 'd'.repeat(64);
const vllm = (digest = VLLM_PINNED) => ({ 'bom-ref': 'image:pkg:docker/vllm/vllm-openai@v0.32.0', name: 'vllm/vllm-openai', version: 'v0.32.0', hashes: [{ alg: 'SHA-256', content: digest }], properties: [{ name: 'koala:kind', value: 'image' }, { name: 'koala:source', value: 'docker.io/vllm/vllm-openai:v0.32.0' }] });

const TABBY_PINNED = 'a'.repeat(64);
const tabby = { 'bom-ref': 'image:pkg:docker/theroyallab/tabbyapi@latest-2026-11-10', name: 'theroyallab/tabbyapi', version: 'latest-2026-11-10', properties: [{ name: 'koala:kind', value: 'image' }, { name: 'koala:source', value: `ghcr.io/theroyallab/tabbyapi@sha256:${TABBY_PINNED}` }, { name: 'koala:tracks', value: 'latest' }] };

const registry = [
  http.all('*', async ({ request }) => {
    const url = request.url;
    const body = request.method === 'POST' ? await request.text() : undefined;
    asked.push({ url, ...(body !== undefined ? { body } : {}) });
    const ok = (answer: unknown) => HttpResponse.json(answer as never);
    if (url.endsWith('/querybatch')) {
      if (osvStatus !== 200) return new HttpResponse('{}', { status: osvStatus });
      const { queries } = JSON.parse(body ?? '{}') as { queries: { package: { name: string }; version: string }[] };
      return ok({ results: queries.map((query) => ({
        vulns: query.package.name === 'seroval' && query.version === '1.6.7' ? [{ id: 'GHSA-seroval' }]
          : query.package.name === 'github.com/k3s-io/k3s' ? [{ id: 'GO-k3s' }]
            : query.package.name === '@xmldom/xmldom' ? [{ id: 'GHSA-xmldom' }] : [],
      })) });
    }
    if (url.startsWith('https://auth.docker.io/') || url.startsWith('http://sources.test/docker-auth/')) {
      if (hub.token !== 200) return new HttpResponse('{}', { status: hub.token });
      const scope = new URL(url).searchParams;
      if (scope.get('service') !== 'registry.docker.io' || scope.get('scope') !== 'repository:vllm/vllm-openai:pull') return new HttpResponse('{}', { status: 400 });
      return ok({ token: 'hub-anonymous' });
    }
    if (url.startsWith('https://registry-1.docker.io/') || url.startsWith('http://sources.test/docker-hub/')) {
      if (request.headers.get('authorization') !== 'Bearer hub-anonymous') return new HttpResponse('{}', { status: 401 });
      if (!(request.headers.get('accept') ?? '').includes('application/vnd.oci.image.index.v1+json')) return new HttpResponse('{}', { status: 406 });
      if (new URL(url).pathname.replace(/^\/docker-hub/, '') !== `/v2/vllm/vllm-openai/manifests/sha256:${VLLM_PINNED}`) return new HttpResponse(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }), { status: 404 });
      return new HttpResponse(hub.body === undefined ? '{}' : JSON.stringify(hub.body), { status: hub.manifest, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://ghcr.io/') || url.startsWith('http://sources.test/ghcr/')) {
      if (ghcrStatus !== 200) return new HttpResponse('{}', { status: ghcrStatus });
      const path = url.replace(/^https:\/\/ghcr\.io|^http:\/\/sources\.test\/ghcr/, '');
      if (path === '/token?scope=repository%3Atheroyallab%2Ftabbyapi%3Apull' || path === '/token?scope=repository:theroyallab/tabbyapi:pull') return ok({ token: 'anonymous' });
      if (request.headers.get('authorization') !== 'Bearer anonymous') return new HttpResponse('{}', { status: 401 });
      if (path === '/v2/theroyallab/tabbyapi/manifests/latest') return HttpResponse.json({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } }, { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }] } as never, { headers: { 'docker-content-digest': `sha256:${tabbyLatest}` } });
      if (path === `/v2/theroyallab/tabbyapi/manifests/sha256:${TABBY_PINNED}`) return ok({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] });
      if (path === '/v2/theroyallab/tabbyapi/manifests/sha256:amd') return ok({ config: { digest: 'sha256:config' } });
      if (path === '/v2/theroyallab/tabbyapi/blobs/sha256:config') return ok({ config: { Labels: { 'org.opencontainers.image.created': '2026-11-12T20:00:00Z', 'org.opencontainers.image.revision': 'c0ffee' } } });
      return new HttpResponse('{}', { status: 404 });
    }
    const vuln = /\/vulns\/(.+)$/.exec(url)?.[1];
    if (vuln) return ok(ADVISORIES[decodeURIComponent(vuln)]);
    if (url === 'https://registry.npmjs.org/seroval' || url === 'http://sources.test/npm/seroval') return ok({ time: { '1.6.8': '2026-09-29T00:00:00Z', '1.6.11': seroval11At } });
    if (url === 'https://registry.npmjs.org/@xmldom%2Fxmldom' || url === 'http://sources.test/npm/@xmldom%2Fxmldom') return ok({ time: { '0.8.11': '2026-08-01T00:00:00Z' } });
    if (url.includes('/repos/k3s-io/k3s/releases/tags/v1.36.5%2Bk3s1')) return ok({ published_at: '2026-10-25T00:00:00Z' });
    return new HttpResponse('{}', { status: 404 });
  }),
];

const server = interceptHttp(...registry);

let db: Database;
let told: { subject: string; text: string }[];

beforeEach(async () => {
  db = memoryDatabase();
  asked = [];
  osvStatus = 200;
  ghcrStatus = 200;
  tabbyLatest = 'b'.repeat(64);
  hub = { token: 200, manifest: 200 };
  seroval11At = '2026-10-18T00:00:00Z';
  told = [];
  await db.instances.recordRelease({ imageTag: 'aaaaaaaaaaaa', version: 'v2026.10.23', servedAt: '2026-10-23T00:00:00Z' });
  await db.instances.recordRelease({ imageTag: 'bbbbbbbbbbbb', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' });
  await db.instances.saveInstance({ id: 'inst-1', ownerId: 'owner-1', url: 'https://luno.example', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', name: 'luno', running: 'aaaaaaaaaaaa' });
});

const watch = (at: string) => new DependencyWatch({
  store: db.instances,
  inventoryOf: async (tag) => inventories[tag],
  currentRelease: 'bbbbbbbbbbbb',
  fetchImpl: fetch,
  sources: { osv: 'https://api.osv.dev/v1', npm: 'https://registry.npmjs.org', github: 'https://api.github.com', ghcr: 'https://ghcr.io', dockerHub: 'https://registry-1.docker.io', dockerAuth: 'https://auth.docker.io' },
  tell: async (message) => { told.push(message); },
  rootUrl: 'https://app.example.com',
  now: () => new Date(at),
});

describe('root\'s daily check of what its running releases are made of', () => {
  it('asks OSV once for every component of every release some instance or root runs, never a floating image', async () => {
    const { check, findings } = await watch('2026-10-29T12:00:00Z').check();
    const batch = asked.filter((entry) => entry.url.endsWith('/querybatch'));
    expect(batch).toHaveLength(1);
    const queries = (JSON.parse(batch[0]!.body!) as { queries: { package: { name: string }; version: string }[] }).queries.map((query) => `${query.package.name}@${query.version}`).sort();
    expect(queries).toEqual(['github.com/k3s-io/k3s@1.36.4+k3s1', 'left-pad@1.3.0', 'seroval@1.6.11', 'seroval@1.6.7']);
    expect(check!.releases.map((release) => [release.label, release.instances, release.root])).toEqual([['v2026.10.23', ['luno'], false], ['v2026.10.29', [], true]]);
    expect(findings.map((finding) => [finding.component.name, finding.advisory.id, finding.state, finding.releases])).toEqual([
      ['seroval', 'GHSA-seroval', 'due', ['v2026.10.23']],
      ['k3s', 'GO-k3s', 'waiting', ['v2026.10.23', 'v2026.10.29']],
    ]);
    expect(findings[1]).toMatchObject({ fix: '1.36.5+k3s1', takeOn: '2026-11-08', instances: ['luno'], advisory: { severity: 'critical' } });
    expect(check!.components.find((component) => component.name === 'k3s')).toMatchObject({ checked: true, publishedAt: '2026-09-01T00:00:00Z' });
    expect(check!.components.find((component) => component.name === 'mongo')).toMatchObject({ checked: false });
  });

  it('takes each pinned component\'s age from the release date recorded with its pin, asking GitHub nothing for it', async () => {
    const { check } = await watch('2026-10-29T12:00:00Z').check();
    expect(check!.components.find((component) => component.name === 'k3s')).toMatchObject({ publishedAt: '2026-09-01T00:00:00Z' });
    expect(asked.filter((entry) => entry.url.includes('v1.36.4'))).toEqual([]);
  });

  it('asks when a fix was published once: a later check takes the date its finding kept', async () => {
    await watch('2026-10-29T12:00:00Z').check();
    asked.length = 0;
    const { findings } = await watch('2026-10-30T12:00:00Z').check();
    expect(findings.map((finding) => [finding.component.name, finding.fixPublishedAt])).toEqual([['seroval', '2026-09-29T00:00:00Z'], ['k3s', '2026-10-25T00:00:00Z']]);
    expect(asked.filter((entry) => entry.url.startsWith('https://registry.npmjs.org/') || entry.url.startsWith('https://api.github.com/'))).toEqual([]);
  });

  it('asks OSV, npm and GitHub at the addresses it is given, and nowhere else', async () => {
    const elsewhere = new DependencyWatch({
      store: db.instances,
      inventoryOf: async (tag) => inventories[tag],
      currentRelease: 'bbbbbbbbbbbb',
      fetchImpl: fetch,
      sources: { osv: 'http://sources.test/osv', npm: 'http://sources.test/npm', github: 'http://sources.test/github', ghcr: 'http://sources.test/ghcr', dockerHub: 'http://sources.test/docker-hub', dockerAuth: 'http://sources.test/docker-auth' },
      tell: async () => undefined,
      rootUrl: 'https://app.example.com',
      now: () => new Date('2026-10-29T12:00:00Z'),
    });
    await elsewhere.check();
    expect(asked.map((entry) => new URL(entry.url).host)).toEqual(asked.map(() => 'sources.test'));
    expect(asked.map((entry) => new URL(entry.url).pathname)).toEqual(expect.arrayContaining(['/osv/querybatch', '/osv/vulns/GHSA-seroval', '/npm/seroval', '/github/repos/k3s-io/k3s/releases/tags/v1.36.5%2Bk3s1']));
  });

  it('tells the operator a new advisory once, and again only when its fix comes due', async () => {
    await watch('2026-10-29T12:00:00Z').check();
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toBe('Koala\'s dependencies: 2 new advisories');
    await watch('2026-10-30T12:00:00Z').check();
    expect(told).toHaveLength(1);
    await watch('2026-11-09T12:00:00Z').check();
    expect(told).toHaveLength(2);
    expect(told[1]!.subject).toBe('Koala\'s dependencies: 1 fix now due');
    expect(told[1]!.text).toContain('k3s@v1.36.4+k3s1: GO-k3s (critical), its fix is now two weeks old');
  });

  it('tells an instance what its release carries and which newer release fixes each', async () => {
    const watcher = watch('2026-10-29T12:00:00Z');
    await watcher.check();
    const answer = await watcher.forRelease('aaaaaaaaaaaa');
    expect(answer.release).toBe('v2026.10.23');
    expect(answer.findings.map((finding) => [finding.component.name, finding.state, finding.fixedBy])).toEqual([
      ['seroval', 'due', 'v2026.10.29'],
      ['k3s', 'waiting', undefined],
    ]);
    expect((await watcher.forRelease('bbbbbbbbbbbb')).findings.map((finding) => finding.component.name)).toEqual(['k3s']);
  });

  it('judges only what Koala runs, as ship does: a development tool\'s advisory is listed apart, never told and never counted for an instance', async () => {
    const xmldom = { ...npm('@xmldom/xmldom', '0.8.10', [{ name: 'koala:dev', value: 'true' }]), scope: 'excluded' };
    inventories.aaaaaaaaaaaa = { components: [npm('seroval', '1.6.7'), npm('left-pad', '1.3.0'), k3s, mongo, xmldom] };
    try {
      const watcher = watch('2026-10-29T12:00:00Z');
      const { findings } = await watcher.check();
      expect(findings.filter((finding) => !finding.devOnly).map((finding) => [finding.component.name, finding.state])).toEqual([['seroval', 'due'], ['k3s', 'waiting']]);
      expect(findings.filter((finding) => finding.devOnly).map((finding) => [finding.component.name, finding.state])).toEqual([['@xmldom/xmldom', 'due']]);
      expect(told).toHaveLength(1);
      expect(told[0]!.subject).toBe('Koala\'s dependencies: 2 new advisories');
      expect(told[0]!.text).not.toContain('xmldom');
      expect((await watcher.forRelease('aaaaaaaaaaaa')).findings.map((finding) => finding.component.name)).toEqual(['seroval', 'k3s']);
    } finally {
      inventories.aaaaaaaaaaaa = { components: [npm('seroval', '1.6.7'), npm('left-pad', '1.3.0'), k3s, mongo] };
    }
  });

  it('says which release it could not check, rather than calling it clean', async () => {
    await db.instances.saveInstance({ id: 'inst-2', ownerId: 'owner-2', url: 'https://old.example', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', name: 'old', running: 'cccccccccccc' });
    const { check } = await watch('2026-10-29T12:00:00Z').check();
    expect(check!.problems).toEqual(['no inventory is kept for cccccccccccc, so it was not checked']);
    expect(check!.releases.find((release) => release.release === 'cccccccccccc')).toMatchObject({ inventory: false, instances: ['old'] });
  });

  it('shows the last check and the findings it kept without asking anyone', async () => {
    const watcher = watch('2026-10-29T12:00:00Z');
    expect(await watcher.view()).toEqual({ check: undefined, findings: [] });
    const { check, findings } = await watcher.check();
    asked.length = 0;
    expect(await watcher.view()).toEqual({ check, findings });
    expect(asked).toEqual([]);
  });

  it('fails the check, keeping what it had, when OSV cannot be asked', async () => {
    osvStatus = 503;
    await expect(watch('2026-10-29T12:00:00Z').check()).rejects.toThrow('answered 503');
    expect(await db.instances.getDependencyCheck()).toBeUndefined();
  });

  it('leaves a fix undated, and says why, when npm or GitHub cannot be read', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      server.use(http.get('https://registry.npmjs.org/*', () => new HttpResponse('{}', { status: 500 })), http.get('https://api.github.com/*', () => new HttpResponse('{}', { status: 500 })));
      const { findings } = await watch('2026-10-29T12:00:00Z').check();
      expect(findings.map((finding) => [finding.component.name, finding.state, finding.takeOn])).toEqual([['seroval', 'due', undefined], ['k3s', 'due', undefined]]);
      expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([expect.stringContaining("seroval's versions were published could not be read"), expect.stringContaining('k3s-io/k3s released')]));
    } finally {
      warned.mockRestore();
    }
  });

  describe('an image pinned by digest from a tag that moves', () => {
    const withTabby = async (run: () => Promise<void>) => {
      const was = inventories.bbbbbbbbbbbb;
      inventories.bbbbbbbbbbbb = { components: [npm('seroval', '1.6.11'), npm('left-pad', '1.3.0'), k3s, mongo, tabby] };
      try { await run(); } finally { inventories.bbbbbbbbbbbb = was; }
    };

    it('lists a newer build of the tag with when it was built and first seen, takeable two weeks after first seen, and takes nothing', async () => {
      await withTabby(async () => {
        const { check } = await watch('2026-11-13T12:00:00Z').check();
        expect(check!.builds).toEqual([{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned: TABBY_PINNED, digest: 'b'.repeat(64), builtAt: '2026-11-12T20:00:00Z', revision: 'c0ffee', firstSeenAt: '2026-11-13T12:00:00.000Z', takeOn: '2026-11-27' }]);
        const later = await watch('2026-11-20T12:00:00Z').check();
        expect(later.check!.builds).toEqual(check!.builds);
        expect(told.map((message) => message.text).join('\n')).not.toContain('tabbyapi');
      });
    });

    it('lists nothing while the tag still names the pinned build', async () => {
      tabbyLatest = TABBY_PINNED;
      await withTabby(async () => {
        expect((await watch('2026-11-13T12:00:00Z').check()).check!.builds).toEqual([]);
      });
    });

    it('says the newest build could not be read, rather than listing none, when the registry does not answer', async () => {
      ghcrStatus = 503;
      await withTabby(async () => {
        const { check } = await watch('2026-11-13T12:00:00Z').check();
        expect(check!.builds).toEqual([]);
        expect(check!.problems).toEqual([
          expect.stringMatching(/^whether theroyallab\/tabbyapi@sha256:aaaaaaaaaaaa is still published could not be checked: .*503/),
          expect.stringMatching(/^the newest build of theroyallab\/tabbyapi:latest could not be read: .*503/),
        ]);
      });
    });
  });

  describe('an image pinned by digest that its registry no longer has', () => {
    const withVllm = async (run: () => Promise<void>, digest = VLLM_PINNED) => {
      const was = inventories.bbbbbbbbbbbb;
      inventories.bbbbbbbbbbbb = { components: [npm('seroval', '1.6.11'), npm('left-pad', '1.3.0'), k3s, mongo, vllm(digest)] };
      try { await run(); } finally { inventories.bbbbbbbbbbbb = was; }
    };
    const goneTold = () => told.filter((message) => message.subject.includes('gone upstream'));

    it('asks Docker Hub for the pinned digest\'s manifest with an anonymous token, and keeps nothing while it is there', async () => {
      await withVllm(async () => {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        expect(asked.map((entry) => entry.url)).toEqual(expect.arrayContaining([
          'https://auth.docker.io/token?service=registry.docker.io&scope=repository:vllm/vllm-openai:pull',
          `https://registry-1.docker.io/v2/vllm/vllm-openai/manifests/sha256:${VLLM_PINNED}`,
        ]));
        expect(check!.gone).toEqual([]);
        expect(check!.problems).toEqual([]);
        expect(goneTold()).toEqual([]);
      });
    });

    it('keeps a digest the registry says is gone, with since when, and emails the operator once', async () => {
      hub.manifest = 404;
      await withVllm(async () => {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        expect(check!.gone).toEqual([{ image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: VLLM_PINNED, since: '2026-11-14T06:00:00.000Z', releases: ['v2026.10.29'] }]);
        expect(goneTold()).toHaveLength(1);
        expect(goneTold()[0]!.subject).toBe('Koala\'s dependencies: 1 pinned image gone upstream');
        expect(goneTold()[0]!.text).toContain('- vllm/vllm-openai@sha256:dddddddddddd (docker.io/vllm/vllm-openai:v0.32.0), pinned in v2026.10.29');
        expect(goneTold()[0]!.text).toContain('See it on Koala\'s dependencies: https://app.example.com/#/dependencies');
        const later = await watch('2026-11-15T06:00:00Z').check();
        expect(later.check!.gone).toEqual(check!.gone);
        expect(goneTold()).toHaveLength(1);
        expect((await watch('2026-11-15T06:00:00Z').view()).check!.gone).toEqual(check!.gone);
      });
    });

    it('takes the registry\'s MANIFEST_UNKNOWN as gone too', async () => {
      hub.manifest = 400;
      hub.body = { errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] };
      await withVllm(async () => {
        expect((await watch('2026-11-14T06:00:00Z').check()).check!.gone!.map((entry) => entry.image)).toEqual(['vllm/vllm-openai']);
      });
    });

    it('clears it once the digest answers again, and when the pin moves to another digest', async () => {
      hub.manifest = 404;
      await withVllm(async () => {
        await watch('2026-11-14T06:00:00Z').check();
        hub.manifest = 200;
        expect((await watch('2026-11-15T06:00:00Z').check()).check!.gone).toEqual([]);
      });
      await withVllm(async () => {
        hub.manifest = 404;
        await watch('2026-11-16T06:00:00Z').check();
      });
      await withVllm(async () => {
        const { check } = await watch('2026-11-17T06:00:00Z').check();
        expect(check!.gone).toEqual([{ image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: 'e'.repeat(64), since: '2026-11-17T06:00:00.000Z', releases: ['v2026.10.29'] }]);
      }, 'e'.repeat(64));
    });

    it('says the digest could not be checked, never gone and never fine, when the token service or the registry answers anything else', async () => {
      hub.token = 503;
      await withVllm(async () => {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        expect(check!.gone).toEqual([]);
        expect(check!.problems).toEqual([`whether vllm/vllm-openai@sha256:dddddddddddd is still published could not be checked: asking docker.io's token service, it answered 503`]);
      });
      hub.token = 200;
      hub.manifest = 401;
      await withVllm(async () => {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        expect(check!.gone).toEqual([]);
        expect(check!.problems).toEqual([`whether vllm/vllm-openai@sha256:dddddddddddd is still published could not be checked: asking docker.io for its manifest, it refused the request (401)`]);
      });
      expect(goneTold()).toEqual([]);
    });

    it('keeps a digest known gone while its registry cannot be asked', async () => {
      hub.manifest = 404;
      await withVllm(async () => {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        hub.manifest = 503;
        const later = await watch('2026-11-15T06:00:00Z').check();
        expect(later.check!.gone).toEqual(check!.gone);
        expect(later.check!.problems).toEqual([expect.stringContaining('could not be checked: asking docker.io for its manifest, it answered 503')]);
        expect(goneTold()).toHaveLength(1);
      });
    });

    it('says a registry Koala does not ask could not be checked', async () => {
      const was = inventories.bbbbbbbbbbbb;
      inventories.bbbbbbbbbbbb = { components: [{ ...vllm(), properties: [{ name: 'koala:kind', value: 'image' }, { name: 'koala:source', value: 'nvcr.io/nvidia/k8s-device-plugin:v0.20.1' }] }] };
      try {
        const { check } = await watch('2026-11-14T06:00:00Z').check();
        expect(check!.problems).toEqual(['whether vllm/vllm-openai@sha256:dddddddddddd is still published could not be checked: Koala asks only docker.io and ghcr.io, and it is on nvcr.io']);
      } finally {
        inventories.bbbbbbbbbbbb = was;
      }
    });
  });
});
