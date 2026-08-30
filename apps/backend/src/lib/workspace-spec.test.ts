import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkspaceManifests, workspaceNamespace, WORKSPACE_POD, MAX_WORKSPACE_SECONDS, describeSandbox} from './workspace-spec.js';
import { packageAccess, imageForLanguage, isWorkspaceLanguage } from './workspace-image-catalogue.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE, DEFAULT_WORKSPACE_LANGUAGE } from './workspace-image-seeds.js';

const spec = { leafId: 'aaaa-bbbb-cccc', ownerId: 'user-1' };
const find = (kind: string, manifests = buildWorkspaceManifests(IMAGES, spec)) =>
  manifests.find((m) => m.kind === kind) as any;

describe('workspaceNamespace', () => {
  it('derives a valid Kubernetes name from a leaf id', () => {
    expect(workspaceNamespace('aaaa-bbbb-cccc')).toBe('koala-ws-aaaa-bbbb-cccc');
  });

  it('sanitises anything that is not a legal name character', () => {
    expect(workspaceNamespace('Leaf/../Other Thing')).toBe('koala-ws-leaf-other-thing');
  });

  it('stays within the 63-character limit and never ends in a dash', () => {
    const ns = workspaceNamespace('x'.repeat(200));
    expect(ns.length).toBeLessThanOrEqual(63);
    expect(ns).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it('refuses an id with nothing usable in it, rather than inventing a namespace', () => {
    expect(() => workspaceNamespace('---')).toThrow();
  });
});

describe('the sandbox pod', () => {
  it('never mounts a service-account token', () => {
    expect(find('Pod').spec.automountServiceAccountToken).toBe(false);
  });

  it('runs unprivileged, as a non-root user, with no capabilities', () => {
    const pod = find('Pod');
    expect(pod.spec.securityContext.runAsNonRoot).toBe(true);
    expect(pod.spec.securityContext.runAsUser).not.toBe(0);
    const container = pod.spec.containers[0];
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toContain('ALL');
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
  });

  it('starts idle, so nothing runs that a tool call did not ask for', () => {
    expect(find('Pod').spec.containers[0].command[0]).toBe('sleep');
  });

  it('is capped in cpu, memory and wall-clock', () => {
    const pod = find('Pod');
    expect(pod.spec.activeDeadlineSeconds).toBe(MAX_WORKSPACE_SECONDS);
    expect(pod.spec.containers[0].resources.limits).toMatchObject({ cpu: '2', memory: '2Gi' });
    expect(pod.spec.restartPolicy).toBe('Never');
  });

  it('has a writable workspace and tmp despite the read-only root', () => {
    const container = find('Pod').spec.containers[0];
    expect(container.volumeMounts.map((v: any) => v.mountPath).sort()).toEqual(['/tmp', '/work']);
  });

  it('uses a fixed pod name, so exec never has to discover one', () => {
    expect(find('Pod').metadata.name).toBe(WORKSPACE_POD);
  });
});

describe('the network policy', () => {
  it('denies all ingress — nothing should ever dial into a sandbox', () => {
    expect(find('NetworkPolicy').spec.ingress).toEqual([]);
  });

  it('allows DNS and nothing else by default', () => {
    const egress = find('NetworkPolicy').spec.egress;
    expect(egress).toHaveLength(1);
    expect(egress[0].ports.map((p: any) => p.port)).toEqual([53, 53]);
    expect(egress[0].to).toBeUndefined();
  });

  it('covers every pod in the namespace, not just the one we create', () => {
    expect(find('NetworkPolicy').spec.podSelector).toEqual({});
    expect(find('NetworkPolicy').spec.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
  });

  it('opens exactly what an allowlist asks for, and no more', () => {
    const manifests = buildWorkspaceManifests(IMAGES, { ...spec, egress: [{ cidr: '10.0.0.5/32', ports: [443] }] });
    const egress = find('NetworkPolicy', manifests).spec.egress;
    expect(egress).toHaveLength(2);
    expect(egress[1].to).toEqual([{ ipBlock: { cidr: '10.0.0.5/32' } }]);
    expect(egress[1].ports).toEqual([{ protocol: 'TCP', port: 443 }]);
  });

  it('scopes the namespace to its owner, so orphans are findable', () => {
    expect(find('Namespace').metadata.labels['koala.dev/owner']).toBe('user-1');
    expect(find('Namespace').metadata.labels['koala.dev/leaf']).toBe('aaaa-bbbb-cccc');
  });
});

describe('describeSandbox', () => {
  const text = describeSandbox(IMAGES);

  it('warns that each command is a fresh shell', () => {
    expect(text).toMatch(/FRESH shell/);
    expect(text).toMatch(/do NOT carry over/i);
  });

  it('warns that nproc and free report the host, not the limits', () => {
    expect(text).toMatch(/IGNORE `nproc` and `free`/);
    expect(text).toContain('2 CPUs and 2Gi');
  });

  it('says plainly that downloads will fail, since that is the least guessable constraint', () => {
    expect(text).toMatch(/NO outbound network/);
    expect(text).toMatch(/npm install.*WILL fail/);
  });

  it('lists what is missing, not just what is present', () => {
    expect(text).toMatch(/NOT installed:.*\bgo\b/);
    expect(text).toMatch(/Available:.*\bgit\b/);
  });

  it('reflects an egress allowlist instead of claiming there is no network', () => {
    const allowed = describeSandbox(IMAGES, { egress: [{ cidr: '10.1.2.3/32', ports: [443] }] });
    expect(allowed).toContain('10.1.2.3/32');
    expect(allowed).not.toMatch(/NO outbound network/);
  });

  it('admits ignorance for an uncatalogued image rather than describing the wrong one', () => {
    const custom = describeSandbox(IMAGES, { image: 'ghcr.io/example/custom:1' });
    expect(custom).toContain('ghcr.io/example/custom:1');
    expect(custom).toMatch(/not catalogued/);
    expect(custom).not.toContain('BusyBox');
  });

  it('tracks the real limits when they are overridden', () => {
    expect(describeSandbox(IMAGES, { cpu: '8', memory: '16Gi' })).toContain('8 CPUs and 16Gi');
  });
});

describe('the image catalogue', () => {
  it('ships git everywhere a commit could happen', () => {
    for (const [language, entry] of Object.entries(BY_LANGUAGE)) {
      if (language === 'base') {
        expect(entry.absent).toContain('git');
        expect(entry.summary).toMatch(/no git/i);
        continue;
      }
      expect(entry.available.join(' ')).toMatch(/\bgit\b/);
    }
  });

  it('is Red Hat UBI throughout', () => {
    for (const entry of Object.values(BY_LANGUAGE)) {
      expect(entry.image).toMatch(/^registry\.access\.redhat\.com\/ubi9\//);
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

  it('describes the image a language actually resolves to', () => {
    const go = describeSandbox(IMAGES, { image: imageForLanguage(IMAGES, 'go') });
    expect(go).toMatch(/go 1\.26/);
    expect(go).not.toMatch(/not catalogued/);
  });
});

describe('what the brief says about installing packages', () => {
  const py = BY_LANGUAGE.python.image;

  it('does not promise pip when only the npm mirror is served', () => {
    const brief = describeSandbox(IMAGES, {
      image: py,
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://koala-registry:4873' }],
    });
    expect(brief).toMatch(/pip install.*(WILL fail|will fail)/);
  });

  it('still says npm works, because it does', () => {
    const brief = describeSandbox(IMAGES, {
      image: py,
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://koala-registry:4873' }],
    });
    expect(brief).toMatch(/npm install/);
    expect(brief).toContain('http://koala-registry:4873');
  });

  it('promises pip once something actually serves it', () => {
    const brief = describeSandbox(IMAGES, {
      image: py,
      egress: [{ namespace: 'koala-pypi', ports: [8080] }],
      env: [{ name: 'PIP_INDEX_URL', value: 'http://koala-pypi:8080/simple' }],
    });
    expect(brief).toContain('http://koala-pypi:8080/simple');
    expect(brief).toMatch(/`pip install` works/);
    expect(brief).not.toMatch(/`pip install`[^.]*WILL fail/);
  });

  it('says nothing about a manager the image does not have', () => {
    const brief = describeSandbox(IMAGES, {
      image: BY_LANGUAGE.base.image,
      egress: [{ namespace: 'gitea', ports: [3000] }],
      env: [],
    });
    expect(brief).not.toMatch(/npm install/);
    expect(brief).not.toMatch(/pip install/);
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

  it('gives the bare image nothing, because it has no package manager', () => {
    expect(packageAccess(IMAGES, 'base')).toEqual({ env: [], egress: [] });
  });

  it('gives an unknown language the default toolchain\'s access', () => {
    expect(packageAccess(IMAGES, undefined)).toEqual(packageAccess(IMAGES, 'node'));
  });

  it('names only hosts the committed allowlist actually permits', () => {
    const filter = readFileSync(join(import.meta.dirname, '../../../../k8s/koala-egress/egress-proxy.yaml'), 'utf8');
    const allowed = [...filter.matchAll(/^\s{4}\^(.+)\$$/gm)].map((m) => m[1]!.replace(/\\/g, ''));
    for (const language of ['node', 'python', 'go'] as const) {
      const hosts = packageAccess(IMAGES, language).env
        .flatMap((e) => e.value.split(','))
        .map((part) => part.trim().replace(/^https?:\/\//, '').split(/[/:]/)[0]!)
        .filter((h) => h && h !== 'direct' && h !== 'off' && !h.endsWith('.svc.cluster.local'));
      for (const host of hosts) {
        expect(allowed.some((a) => a === host || (a.startsWith('.+.') && host.endsWith(a.slice(2)))), `${host} is not in the proxy allowlist`).toBe(true);
      }
    }
  });
});
