import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageAccess, imageForLanguage, isWorkspaceLanguage } from './workspace-image-catalogue.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE, DEFAULT_WORKSPACE_LANGUAGE } from './workspace-image-seeds.js';

describe('the image catalogue', () => {
  it('ships git everywhere a commit could happen', () => {
    for (const [language, entry] of Object.entries(BY_LANGUAGE)) {
      expect(entry.available.join(' '), language).toMatch(/\bgit\b/);
    }
  });

  it('is Red Hat UBI throughout, except a product that has to be its own official image', () => {
    const official: Record<string, string> = { odoo: 'odoo:18', 'odoo-20': 'odoo:20' };
    for (const entry of Object.values(BY_LANGUAGE)) {
      if (official[entry.id]) expect(entry.image).toBe(official[entry.id]);
      else expect(entry.image).toMatch(/^registry\.access\.redhat\.com\/ubi9\//);
    }
  });

  it('never lists a tool as both present and absent', () => {
    for (const entry of Object.values(BY_LANGUAGE)) {
      const present = entry.available.map((t) => t.split(' ')[0]);
      for (const missing of entry.absent) expect(present).not.toContain(missing);
    }
  });

  it('falls back to the default rather than failing on an unknown language', () => {
    expect(imageForLanguage(IMAGES, 'rust')).toBe(BY_LANGUAGE[DEFAULT_WORKSPACE_LANGUAGE].image);
    expect(imageForLanguage(IMAGES, undefined)).toBe(BY_LANGUAGE[DEFAULT_WORKSPACE_LANGUAGE].image);
    expect(isWorkspaceLanguage(IMAGES, 'rust')).toBe(false);
    expect(isWorkspaceLanguage(IMAGES, 'go')).toBe(true);
  });
});

describe('the package sources a language needs', () => {
  it('points node at the in-cluster npm mirror', () => {
    const { env, egress } = packageAccess(IMAGES, 'node');
    expect(env.find((e) => e.name === 'NPM_CONFIG_REGISTRY')?.value).toContain('koala-registry');
    expect(egress.find((r) => r.namespace === 'koala-registry')?.ports).toContain(4873);
  });

  it('sends python out through the egress proxy, because nothing mirrors PyPI here', () => {
    const { env, egress } = packageAccess(IMAGES, 'python');
    expect(env.find((e) => e.name === 'PIP_INDEX_URL')?.value).toContain('pypi.org');
    expect(egress.find((r) => r.namespace === 'koala-egress')?.ports).toContain(8888);
    expect(env.find((e) => e.name === 'HTTPS_PROXY')?.value).toContain('egress-proxy');
  });

  it('sets both proxy spellings, because tools disagree about the case', () => {
    const names = packageAccess(IMAGES, 'python').env.map((e) => e.name);
    expect(names).toContain('HTTPS_PROXY');
    expect(names).toContain('https_proxy');
  });

  it('gives python somewhere writable to install into', () => {
    const { env } = packageAccess(IMAGES, 'python');
    const target = env.find((e) => e.name === 'PIP_TARGET')?.value;
    expect(target).toMatch(/^\/work\//);
    expect(env.find((e) => e.name === 'PYTHONPATH')?.value.split(':')).toContain(target);
  });

  it('needs no such thing for node or go, which install into the project', () => {
    for (const language of ['node', 'go'] as const) {
      expect(packageAccess(IMAGES, language).env.find((e) => e.name === 'PIP_TARGET')).toBeUndefined();
    }
  });

  it('gives go its proxy and checksum database', () => {
    const { env } = packageAccess(IMAGES, 'go');
    expect(env.find((e) => e.name === 'GOPROXY')?.value).toContain('proxy.golang.org');
  });

  it('gives a workspace with no particular language the Node workspace\'s access, which is what it runs in', () => {
    expect(packageAccess(IMAGES, 'base')).toEqual(packageAccess(IMAGES, 'node'));
  });

  it('gives an unknown language the default toolchain\'s access', () => {
    expect(packageAccess(IMAGES, undefined)).toEqual(packageAccess(IMAGES, 'node'));
  });

  it('names only hosts the committed allowlist actually permits', () => {
    const filter = readFileSync(join(import.meta.dirname, '../../../../../k8s/koala-egress/egress-proxy.yaml'), 'utf8');
    const line = /acl registries dstdomain (.+)$/m.exec(filter)?.[1] ?? '';
    const allowed = line.trim().split(/\s+/);
    expect(allowed.length).toBeGreaterThan(0);
    for (const language of ['node', 'python', 'go'] as const) {
      const hosts = packageAccess(IMAGES, language).env
        .filter((e) => e.name.toLowerCase() !== 'no_proxy')
        .flatMap((e) => e.value.split(','))
        .map((part) => part.trim().replace(/^https?:\/\//, '').split(/[/:]/)[0]!)
        .filter((h) => h && h !== 'direct' && h !== 'off' && !h.endsWith('.svc.cluster.local'));
      for (const host of hosts) {
        expect(allowed.some((a) => a === host || (a.startsWith('.') && (host.endsWith(a) || host === a.slice(1)))), `${host} is not in the proxy allowlist`).toBe(true);
      }
    }
  });
});
