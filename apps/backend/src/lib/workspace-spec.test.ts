import { describe, it, expect } from 'vitest';
import {
  buildWorkspaceManifests,
  workspaceNamespace,
  WORKSPACE_POD,
  MAX_WORKSPACE_SECONDS,
  describeSandbox,
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
