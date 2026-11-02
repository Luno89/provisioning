import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { DependencyWatch } from './DependencyWatch.js';

const npm = (name: string, version: string, extra: { name: string; value: string }[] = []) =>
  ({ 'bom-ref': `koala:pkg:npm/${name}@${version}`, name, version, properties: [{ name: 'koala:kind', value: 'npm' }, { name: 'koala:in', value: 'koala' }, ...extra] });

const k3s = { 'bom-ref': 'binary:pkg:generic/k3s@v1.36.4+k3s1', name: 'k3s', version: 'v1.36.4+k3s1', properties: [{ name: 'koala:kind', value: 'binary' }, { name: 'koala:osv-ecosystem', value: 'Go' }, { name: 'koala:osv-name', value: 'github.com/k3s-io/k3s' }, { name: 'koala:github', value: 'k3s-io/k3s' }] };
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

function fakeFetch(asked: Asked[], seroval11At = '2026-10-18T00:00:00Z') {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/v1/querybatch')) {
      const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
      return ok({ results: queries.map((query) => ({
        vulns: query.package.name === 'seroval' && query.version === '1.6.7' ? [{ id: 'GHSA-seroval' }]
          : query.package.name === 'github.com/k3s-io/k3s' ? [{ id: 'GO-k3s' }]
            : query.package.name === '@xmldom/xmldom' ? [{ id: 'GHSA-xmldom' }] : [],
      })) });
    }
    const vuln = /\/v1\/vulns\/(.+)$/.exec(url)?.[1];
    if (vuln) return ok(ADVISORIES[decodeURIComponent(vuln)]);
    if (url === 'https://registry.npmjs.org/seroval') return ok({ time: { '1.6.8': '2026-09-29T00:00:00Z', '1.6.11': seroval11At } });
    if (url === 'https://registry.npmjs.org/@xmldom%2Fxmldom' || url === 'https://registry.npmjs.org/@xmldom/xmldom') return ok({ time: { '0.8.11': '2026-08-01T00:00:00Z' } });
    if (url.includes('/repos/k3s-io/k3s/releases/tags/v1.36.5%2Bk3s1')) return ok({ published_at: '2026-10-25T00:00:00Z' });
    if (url.includes('/repos/k3s-io/k3s/releases/tags/v1.36.4%2Bk3s1')) return ok({ published_at: '2026-09-01T00:00:00Z' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

let db: Database;
let told: { subject: string; text: string }[];

beforeEach(async () => {
  db = await testDatabase();
  told = [];
  await db.instances.recordRelease({ imageTag: 'aaaaaaaaaaaa', version: 'v2026.10.23', servedAt: '2026-10-23T00:00:00Z' });
  await db.instances.recordRelease({ imageTag: 'bbbbbbbbbbbb', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' });
  await db.instances.saveInstance({ id: 'inst-1', ownerId: 'owner-1', url: 'https://luno.example', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', name: 'luno', running: 'aaaaaaaaaaaa' });
});

const watch = (asked: Asked[], at: string, seroval11At?: string) => new DependencyWatch({
  store: db.instances,
  inventoryOf: async (tag) => inventories[tag],
  currentRelease: 'bbbbbbbbbbbb',
  fetchImpl: fakeFetch(asked, seroval11At),
  tell: async (message) => { told.push(message); },
  rootUrl: 'https://app.example.com',
  now: () => new Date(at),
});

describe('root\'s daily check of what its running releases are made of', () => {
  it('asks OSV once for every component of every release some instance or root runs, never a floating image', async () => {
    const asked: Asked[] = [];
    const { check, findings } = await watch(asked, '2026-10-29T12:00:00Z').check();
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

  it('tells the operator a new advisory once, and again only when its fix comes due', async () => {
    await watch([], '2026-10-29T12:00:00Z').check();
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toBe('Koala\'s dependencies: 2 new advisories');
    await watch([], '2026-10-30T12:00:00Z').check();
    expect(told).toHaveLength(1);
    await watch([], '2026-11-09T12:00:00Z').check();
    expect(told).toHaveLength(2);
    expect(told[1]!.subject).toBe('Koala\'s dependencies: 1 fix now due');
    expect(told[1]!.text).toContain('k3s@v1.36.4+k3s1: GO-k3s (critical), its fix is now two weeks old');
  });

  it('tells an instance what its release carries and which newer release fixes each', async () => {
    const watcher = watch([], '2026-10-29T12:00:00Z');
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
      const watcher = watch([], '2026-10-29T12:00:00Z');
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
    const { check } = await watch([], '2026-10-29T12:00:00Z').check();
    expect(check!.problems).toEqual(['no inventory is kept for cccccccccccc, so it was not checked']);
    expect(check!.releases.find((release) => release.release === 'cccccccccccc')).toMatchObject({ inventory: false, instances: ['old'] });
  });
});
