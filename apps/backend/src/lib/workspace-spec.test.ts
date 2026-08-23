import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkspaceManifests,
  workspaceNamespace,
  WORKSPACE_POD,
  MAX_WORKSPACE_SECONDS,
  describeSandbox,
  packageAccess,
  WORKSPACE_IMAGES,
  imageForLanguage,
  isWorkspaceLanguage,
  DEFAULT_WORKSPACE_IMAGE,
} from './workspace-spec.js';

/**
 * These assert the isolation boundary, not the shape of some YAML.
 *
 * The sandbox executes code a model wrote after reading text a model was given, on a cluster that
 * can provision infrastructure. Every property below is one that, if it silently regressed, would
 * not break a single feature — it would just quietly stop containing anything.
 */
const spec = { leafId: 'aaaa-bbbb-cccc', ownerId: 'user-1' };
const find = (kind: string, manifests = buildWorkspaceManifests(spec)) =>
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
    // '---' would sanitise to an empty slug; targeting a guessed namespace is worse than failing.
    expect(() => workspaceNamespace('---')).toThrow();
  });
});

describe('the sandbox pod', () => {
  it('never mounts a service-account token', () => {
    // The single property standing between arbitrary code and the Kubernetes API of a cluster that
    // provisions infrastructure.
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
    // No `to`, so it is port-scoped rather than host-scoped — but with every other port closed,
    // DNS alone reaches nothing.
    expect(egress[0].to).toBeUndefined();
  });

  it('covers every pod in the namespace, not just the one we create', () => {
    expect(find('NetworkPolicy').spec.podSelector).toEqual({});
    expect(find('NetworkPolicy').spec.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
  });

  it('opens exactly what an allowlist asks for, and no more', () => {
    const manifests = buildWorkspaceManifests({ ...spec, egress: [{ cidr: '10.0.0.5/32', ports: [443] }] });
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
  const text = describeSandbox();

  it('warns that each command is a fresh shell', () => {
    // Models default to assuming a persistent session and write recipes that silently run in the
    // wrong directory.
    expect(text).toMatch(/FRESH shell/);
    expect(text).toMatch(/do NOT carry over/i);
  });

  it('warns that nproc and free report the host, not the limits', () => {
    // Verified live: nproc says 32 and free says 31GB inside a pod limited to 2 CPUs and 2Gi.
    expect(text).toMatch(/IGNORE `nproc` and `free`/);
    expect(text).toContain('2 CPUs and 2Gi');
  });

  it('says plainly that downloads will fail, since that is the least guessable constraint', () => {
    expect(text).toMatch(/NO outbound network/);
    expect(text).toMatch(/npm install.*WILL fail/);
  });

  it('lists what is missing, not just what is present', () => {
    // The default image has git; what it lacks is Go, and a planner that assumes otherwise wastes
    // an attempt.
    expect(text).toMatch(/NOT installed:.*\bgo\b/);
    expect(text).toMatch(/Available:.*\bgit\b/);
  });

  it('reflects an egress allowlist instead of claiming there is no network', () => {
    const allowed = describeSandbox({ egress: [{ cidr: '10.1.2.3/32', ports: [443] }] });
    expect(allowed).toContain('10.1.2.3/32');
    expect(allowed).not.toMatch(/NO outbound network/);
  });

  it('admits ignorance for an uncatalogued image rather than describing the wrong one', () => {
    const custom = describeSandbox({ image: 'ghcr.io/example/custom:1' });
    expect(custom).toContain('ghcr.io/example/custom:1');
    expect(custom).toMatch(/not catalogued/);
    expect(custom).not.toContain('BusyBox');
  });

  it('tracks the real limits when they are overridden', () => {
    expect(describeSandbox({ cpu: '8', memory: '16Gi' })).toContain('8 CPUs and 16Gi');
  });
});

describe('the image catalogue', () => {
  it('ships git everywhere a commit could happen', () => {
    // The commit → push → pipeline loop is the point of the workspace. `base` is the documented
    // exception and says so in its own summary.
    for (const [language, entry] of Object.entries(WORKSPACE_IMAGES)) {
      if (language === 'base') {
        expect(entry.absent).toContain('git');
        expect(entry.summary).toMatch(/no git/i);
        continue;
      }
      expect(entry.available.join(' ')).toMatch(/\bgit\b/);
    }
  });

  it('is Red Hat UBI throughout', () => {
    for (const entry of Object.values(WORKSPACE_IMAGES)) {
      expect(entry.image).toMatch(/^registry\.access\.redhat\.com\/ubi9\//);
    }
  });

  it('never lists a tool as both present and absent', () => {
    // The two lists feed the model's plan; a contradiction is worse than an omission.
    for (const entry of Object.values(WORKSPACE_IMAGES)) {
      const present = entry.available.map((t) => t.split(' ')[0]);
      for (const missing of entry.absent) expect(present).not.toContain(missing);
    }
  });

  it('falls back to the default rather than failing on an unknown language', () => {
    // A model naming something outside the enum should still get a working sandbox.
    expect(imageForLanguage('rust')).toBe(DEFAULT_WORKSPACE_IMAGE);
    expect(imageForLanguage(undefined)).toBe(DEFAULT_WORKSPACE_IMAGE);
    expect(isWorkspaceLanguage('rust')).toBe(false);
    expect(isWorkspaceLanguage('go')).toBe(true);
  });

  it('describes the image a language actually resolves to', () => {
    const go = describeSandbox({ image: imageForLanguage('go') });
    expect(go).toMatch(/go 1\.26/);
    expect(go).not.toMatch(/not catalogued/);
  });
});

/**
 * ── WHICH PACKAGE MANAGER, NOT WHETHER SOME REGISTRY EXISTS ──
 *
 * Measured on the first leaf ever to run on a Python tree type: the workspace was the Python image,
 * `NPM_CONFIG_REGISTRY` was set because the npm mirror is always reachable, and the brief therefore
 * said *"A package registry IS reachable … `npm install` works"*. The leaf read that, believed pip
 * had somewhere to go, and spent every remaining turn resolving `pypi-mirror`, `pypi-proxy`,
 * `pypi-registry` and nine `.svc.cluster.local` variants until the circling veto stopped it.
 *
 * The check was `find(NPM_CONFIG_REGISTRY || PIP_INDEX_URL)` — one boolean for two different
 * questions. It was invisible while every workspace was Node; the tree-type work is what made a
 * Python workspace possible at all.
 *
 * So the brief must name the manager it is talking about, and say the OTHER one fails. Both facts
 * come from data already present: the env decides what is served, and the image catalogue's
 * `available` decides which managers exist to ask about.
 */
describe('what the brief says about installing packages', () => {
  const py = WORKSPACE_IMAGES.python.image;

  it('does not promise pip when only the npm mirror is served', () => {
    const brief = describeSandbox({
      image: py,
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://koala-registry:4873' }],
    });
    expect(brief).toMatch(/pip install.*(WILL fail|will fail)/);
  });

  it('still says npm works, because it does', () => {
    // The opposite failure is just as expensive: an agent told installs fail hand-rolls a library.
    const brief = describeSandbox({
      image: py,
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://koala-registry:4873' }],
    });
    expect(brief).toMatch(/npm install/);
    expect(brief).toContain('http://koala-registry:4873');
  });

  it('promises pip once something actually serves it', () => {
    const brief = describeSandbox({
      image: py,
      egress: [{ namespace: 'koala-pypi', ports: [8080] }],
      env: [{ name: 'PIP_INDEX_URL', value: 'http://koala-pypi:8080/simple' }],
    });
    expect(brief).toContain('http://koala-pypi:8080/simple');
    // Anchored on the pip clause alone: the npm clause in the same sentence legitimately says
    // "WILL fail" here, and a looser regex matched across both and failed for the wrong reason.
    expect(brief).toMatch(/`pip install` works/);
    expect(brief).not.toMatch(/`pip install`[^.]*WILL fail/);
  });

  it('says nothing about a manager the image does not have', () => {
    // `base` has no npm and no pip. Listing failures for tools that are not there is noise that
    // pushes the sentences that matter out of the agent's attention.
    const brief = describeSandbox({
      image: WORKSPACE_IMAGES.base.image,
      egress: [{ namespace: 'gitea', ports: [3000] }],
      env: [],
    });
    expect(brief).not.toMatch(/npm install/);
    expect(brief).not.toMatch(/pip install/);
  });
});

/**
 * ── PACKAGE ACCESS FOLLOWS THE LANGUAGE, NOT THE ROLE ──
 *
 * It was hand-written on persona records: 1 of 11 carried `egress: koala-registry` and
 * `env: NPM_CONFIG_REGISTRY`. A Builder could install; a Researcher, a Synthesist or a Merger on the
 * same repository could not, and nothing said why. The same shape of mistake as the Gitea rule — see
 * `GITEA_EGRESS` — and it broke the same way: the moment tree types made a Python workspace
 * possible, the one persona that HAD a registry had the wrong one.
 *
 * Which index a workspace needs is decided by what the code is written in. `npm` is served
 * in-cluster by Verdaccio; `pip` and `go` have no local mirror and reach the real index through the
 * CONNECT proxy in `k8s/koala-egress`, whose allowlist is a file in git for exactly this reason.
 */
describe('the package sources a language needs', () => {
  it('points node at the in-cluster npm mirror', () => {
    const { env, egress } = packageAccess('node');
    expect(env.find((e) => e.name === 'NPM_CONFIG_REGISTRY')?.value).toContain('koala-registry');
    expect(egress.find((r) => r.namespace === 'koala-registry')?.ports).toContain(4873);
  });

  it('sends python out through the egress proxy, because nothing mirrors PyPI here', () => {
    const { env, egress } = packageAccess('python');
    expect(env.find((e) => e.name === 'PIP_INDEX_URL')?.value).toContain('pypi.org');
    // The proxy is the ONLY way out; without this rule the variable points somewhere unreachable.
    expect(egress.find((r) => r.namespace === 'koala-egress')?.ports).toContain(8888);
    expect(env.find((e) => e.name === 'HTTPS_PROXY')?.value).toContain('egress-proxy');
  });

  it('sets both proxy spellings, because tools disagree about the case', () => {
    // curl and pip read `https_proxy`; many Go and Node tools read `HTTPS_PROXY`. Setting one and
    // not the other is a failure that looks like the allowlist rejecting the host.
    const names = packageAccess('python').env.map((e) => e.name);
    expect(names).toContain('HTTPS_PROXY');
    expect(names).toContain('https_proxy');
  });

  it('gives python somewhere writable to install into', () => {
    /**
     * Layer 3 makes the root filesystem read-only, and Python is the only one of the three that
     * installs OUTSIDE the project directory by default. Measured in a live sandbox: pip downloaded
     * every wheel through the proxy and then died with `[Errno 30] Read-only file system:
     * '/opt/app-root/lib/python3.12/site-packages/urllib3'` — so the network fix alone bought a
     * longer failure, not a working install.
     *
     * `--user` is not the answer: the image is a virtualenv, and pip refuses `--user` inside one.
     * `PIP_TARGET` works there, and the same directory has to be on `PYTHONPATH` or the install
     * succeeds and the import still fails.
     */
    const { env } = packageAccess('python');
    const target = env.find((e) => e.name === 'PIP_TARGET')?.value;
    expect(target).toMatch(/^\/work\//);
    expect(env.find((e) => e.name === 'PYTHONPATH')?.value.split(':')).toContain(target);
  });

  it('needs no such thing for node or go, which install into the project', () => {
    // npm writes ./node_modules and go writes GOMODCACHE, both already under /work.
    for (const language of ['node', 'go'] as const) {
      expect(packageAccess(language).env.find((e) => e.name === 'PIP_TARGET')).toBeUndefined();
    }
  });

  it('gives go its proxy and checksum database', () => {
    const { env } = packageAccess('go');
    expect(env.find((e) => e.name === 'GOPROXY')?.value).toContain('proxy.golang.org');
  });

  it('gives the bare image nothing, because it has no package manager', () => {
    expect(packageAccess('base')).toEqual({ env: [], egress: [] });
  });

  it('gives an unknown language the default toolchain\'s access', () => {
    // `imageForLanguage` already falls back to node rather than failing; this has to agree with it,
    // or a workspace gets the Node image and no registry.
    expect(packageAccess(undefined)).toEqual(packageAccess('node'));
  });

  it('names only hosts the committed allowlist actually permits', () => {
    /**
     * The proxy runs `FilterDefaultDeny Yes`, so a host we point a tool at but never allowlisted
     * fails as a refused CONNECT — which reads exactly like the package not existing. This asserts
     * the two files agree, rather than trusting that whoever edits one remembers the other.
     */
    const filter = readFileSync(join(import.meta.dirname, '../../../../k8s/koala-egress/egress-proxy.yaml'), 'utf8');
    const allowed = [...filter.matchAll(/^\s{4}\^(.+)\$$/gm)].map((m) => m[1]!.replace(/\\/g, ''));
    for (const language of ['node', 'python', 'go'] as const) {
      // `GOPROXY` is a comma-separated list and `GOSUMDB` is a bare hostname, so this splits and
      // strips rather than assuming one URL per variable — the first version missed both.
      const hosts = packageAccess(language).env
        .flatMap((e) => e.value.split(','))
        .map((part) => part.trim().replace(/^https?:\/\//, '').split(/[/:]/)[0]!)
        .filter((h) => h && h !== 'direct' && h !== 'off' && !h.endsWith('.svc.cluster.local'));
      for (const host of hosts) {
        expect(allowed.some((a) => a === host || (a.startsWith('.+.') && host.endsWith(a.slice(2)))), `${host} is not in the proxy allowlist`).toBe(true);
      }
    }
  });
});
