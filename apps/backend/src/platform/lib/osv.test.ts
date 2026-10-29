import { describe, expect, it } from 'vitest';
import { advisoryFor, batches, idsFromBatch, queryKey, queryOf } from './osv.js';
import { checkedByOsv, inventoryComponents, osvVersion } from './sbom.js';

const bom = {
  components: [
    { 'bom-ref': 'koala:pkg:npm/seroval@1.6.9', name: 'seroval', version: '1.6.9', properties: [{ name: 'koala:kind', value: 'npm' }, { name: 'koala:in', value: 'koala' }] },
    { 'bom-ref': 'koala:pkg:npm/vite@8.0.16', name: 'vite', version: '8.0.16', properties: [{ name: 'koala:kind', value: 'npm' }, { name: 'koala:dev', value: 'true' }] },
    { 'bom-ref': 'binary:pkg:generic/k3s@v1.36.4+k3s1', name: 'k3s', version: 'v1.36.4+k3s1', properties: [{ name: 'koala:kind', value: 'binary' }, { name: 'koala:osv-ecosystem', value: 'Go' }, { name: 'koala:osv-name', value: 'github.com/k3s-io/k3s' }, { name: 'koala:github', value: 'k3s-io/k3s' }] },
    { 'bom-ref': 'image:pkg:docker/library/mongo@7', name: 'mongo', version: '7', properties: [{ name: 'koala:kind', value: 'image' }, { name: 'koala:floating', value: 'true' }] },
    { 'bom-ref': 'unpinned:tailscale', name: 'tailscale', properties: [{ name: 'koala:kind', value: 'unpinned' }] },
    { 'bom-ref': 'other', name: 'not ours' },
  ],
};

describe('reading a release\'s inventory', () => {
  it('keeps each component Koala listed, and which of them OSV can be asked about', () => {
    const components = inventoryComponents(bom);
    expect(components.map((component) => component.name)).toEqual(['seroval', 'vite', 'k3s', 'mongo', 'tailscale']);
    expect(components.filter(checkedByOsv).map((component) => component.name)).toEqual(['seroval', 'vite', 'k3s']);
    expect(components[1]).toMatchObject({ dev: true, ecosystem: 'npm', osvName: 'vite' });
    expect(osvVersion(components[2]!)).toBe('1.36.4+k3s1');
    expect(inventoryComponents(undefined)).toEqual([]);
  });
});

describe('OSV', () => {
  const [seroval, , k3s] = inventoryComponents(bom);

  it('asks about each package by ecosystem, name and version, a thousand at a time', () => {
    expect(queryOf(seroval!)).toEqual({ package: { ecosystem: 'npm', name: 'seroval' }, version: '1.6.9' });
    expect(queryKey(queryOf(k3s!))).toBe('Go|github.com/k3s-io/k3s|1.36.4+k3s1');
    expect(batches(Array.from({ length: 2500 }, (_, at) => at)).map((batch) => batch.length)).toEqual([1000, 1000, 500]);
  });

  it('reads the advisory ids per query, refusing an answer that does not line up', () => {
    expect(idsFromBatch({ results: [{ vulns: [{ id: 'GHSA-a' }, { id: 'GHSA-b' }] }, {}] }, 2)).toEqual([['GHSA-a', 'GHSA-b'], []]);
    expect(() => idsFromBatch({ results: [{}] }, 2)).toThrow(/1 results for 2 queries/);
  });

  it('takes an advisory\'s fixes for the package asked about only, and its severity', () => {
    const record = {
      id: 'GHSA-wp97', summary: 'array length trusted',
      database_specific: { severity: 'HIGH' },
      affected: [
        { package: { ecosystem: 'npm', name: 'seroval' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.6.8' }] }] },
        { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ events: [{ fixed: '9.0.0' }] }] },
      ],
    };
    expect(advisoryFor(record, queryOf(seroval!))).toEqual({ id: 'GHSA-wp97', summary: 'array length trusted', severity: 'high', fixed: ['1.6.8'] });
    expect(advisoryFor({ id: 'X', affected: [] }, queryOf(seroval!))).toEqual({ id: 'X', fixed: [] });
    expect(advisoryFor({}, queryOf(seroval!))).toBeUndefined();
  });
});
