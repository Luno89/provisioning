import { describe, it, expect } from 'vitest';
import {
  normalizeTags, sortTags, pageOf, isNoiseTag, nextPageUrl, isValidImageTag,
  parseTagSort, clampPage, clampPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
} from './registry-tags.js';

describe('isNoiseTag', () => {
  it('drops digests, build caches and per-commit tags', () => {
    for (const tag of [
      'sha256-82e0ec47e5831711f10d3918dd161b1a8feaf4325fac96e1060bd39116c22fb7',
      'buildcache-latest',
      'git-4184121',
      'v1.2.3.sig',
      'metadata',
    ]) {
      expect(isNoiseTag(tag), tag).toBe(true);
    }
  });

  it('keeps anything a user would deploy', () => {
    for (const tag of ['latest', 'cu13', 'latest-extras', 'v3.7.12', '2026.9.0b4', 'stable']) {
      expect(isNoiseTag(tag), tag).toBe(false);
    }
  });
});

describe('normalizeTags', () => {
  it('reverses an oldest-first registry so the newest builds come first', () => {
    const ghcr = ['2021.5.0.dev20210427', '2021.5.0b0', '2025.1.0', '2026.9.0b4'];
    expect(normalizeTags(ghcr, 'oldest-first')).toEqual(
      ['2026.9.0b4', '2025.1.0', '2021.5.0b0', '2021.5.0.dev20210427'],
    );
  });

  it('leaves a newest-first registry alone', () => {
    expect(normalizeTags(['2.36.0', '2.35.1', '2.19.0'], 'newest-first'))
      .toEqual(['2.36.0', '2.35.1', '2.19.0']);
  });

  it('de-duplicates and strips noise without capping', () => {
    const raw = [...Array.from({ length: 60 }, (_, i) => `v${i}`), 'v3', 'sha256-abc'];
    const out = normalizeTags(raw, 'newest-first');
    expect(out).toHaveLength(60);
    expect(out).not.toContain('sha256-abc');
  });
});

describe('sortTags', () => {
  const tags = ['2026.9.0', 'stable', '2025.1.0', 'latest', '2026.10.0'];

  it('floats channel tags to the top on the default newest sort', () => {
    expect(sortTags(tags, 'newest')).toEqual(
      ['stable', 'latest', '2026.9.0', '2025.1.0', '2026.10.0'],
    );
  });

  it('reverses registry order for oldest', () => {
    expect(sortTags(tags, 'oldest')).toEqual(
      ['2026.10.0', 'latest', '2025.1.0', 'stable', '2026.9.0'],
    );
  });

  it('orders version tags numerically, not lexically', () => {
    expect(sortTags(['v2.9.0', 'v2.10.0', 'v2.2.0'], 'version'))
      .toEqual(['v2.10.0', 'v2.9.0', 'v2.2.0']);
  });

  it('keeps channels first and pushes unparseable tags last on a version sort', () => {
    expect(sortTags(['cu13', 'latest', '1.2.0', 'latest-extras'], 'version'))
      .toEqual(['latest', '1.2.0', 'cu13', 'latest-extras']);
  });

  it('sorts alphabetically for name, without floating channels', () => {
    expect(sortTags(['zeta', 'latest', 'alpha'], 'name')).toEqual(['alpha', 'latest', 'zeta']);
  });
});

describe('pageOf', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `v1.0.${i}`);

  it('defaults to the first page of 30, newest first', () => {
    const page = pageOf(hundred);
    expect(page.tags).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page.tags[0]).toBe('v1.0.0');
    expect(page).toMatchObject({ page: 1, pageSize: 30, total: 100, totalPages: 4, sort: 'newest' });
  });

  it('returns the requested slice', () => {
    const page = pageOf(hundred, { page: 2, pageSize: 10 });
    expect(page.tags).toEqual(hundred.slice(10, 20));
    expect(page).toMatchObject({ page: 2, totalPages: 10 });
  });

  it('clamps a page past the end back to the last page', () => {
    expect(pageOf(hundred, { page: 999, pageSize: 25 })).toMatchObject({ page: 4 });
  });

  it('reports a single empty page for a repo with no tags', () => {
    expect(pageOf([])).toMatchObject({ tags: [], page: 1, total: 0, totalPages: 1 });
  });

  it('paginates the sorted list, not the raw one', () => {
    const page = pageOf(['1.0.0', 'latest', '2.0.0'], { page: 1, pageSize: 1, sort: 'version' });
    expect(page.tags).toEqual(['latest']);
  });
});

describe('query parsing', () => {
  it('falls back to newest for an unknown or missing sort', () => {
    expect(parseTagSort('version')).toBe('version');
    expect(parseTagSort('bogus')).toBe('newest');
    expect(parseTagSort(undefined)).toBe('newest');
  });

  it('clamps page and pageSize out of a query string', () => {
    expect(clampPage('3')).toBe(3);
    expect(clampPage('0')).toBe(1);
    expect(clampPage('abc')).toBe(1);
    expect(clampPageSize('50')).toBe(50);
    expect(clampPageSize('9999')).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('nextPageUrl', () => {
  it('resolves a registry v2 relative next link against the registry origin', () => {
    const link = '</v2/home-assistant/home-assistant/tags/list?last=2021.8.0&n=1000>; rel="next"';
    expect(nextPageUrl(link, 'https://ghcr.io')).toBe(
      'https://ghcr.io/v2/home-assistant/home-assistant/tags/list?last=2021.8.0&n=1000',
    );
  });

  it('returns undefined on the last page', () => {
    expect(nextPageUrl(undefined, 'https://ghcr.io')).toBeUndefined();
    expect(nextPageUrl('</v2/foo/tags/list?n=1>; rel="prev"', 'https://ghcr.io')).toBeUndefined();
  });
});

describe('isValidImageTag', () => {
  it('accepts the tags tabbyapi actually publishes', () => {
    for (const tag of ['latest', 'cu13', 'latest-extras']) {
      expect(isValidImageTag(tag), tag).toBe(true);
    }
  });

  it('rejects anything that would corrupt the image reference', () => {
    for (const tag of ['', '.leading-dot', 'has space', 'a:b', 'a/b', undefined, null, 42, 'x'.repeat(129)]) {
      expect(isValidImageTag(tag), String(tag)).toBe(false);
    }
  });
});
