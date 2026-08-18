import { describe, it, expect } from 'vitest';
import { validateSpec, explainSpecProblems } from './app-spec-validate.js';
import { MINIO_SPEC } from './app-spec.js';

/**
 * What a spec is not allowed to do.
 *
 * ── WHY THIS IS THE LOAD-BEARING PART ──
 * A spec is data, which is what makes it safe for Koala to author — but only because something
 * checks it. The argument for a closed schema over "point at a Helm chart" was that a chart can do
 * anything and cannot be validated before it runs. This is where that is either true or a slogan.
 */

const ok = () => ({
  id: 'mongo',
  image: 'mongo:7',
  ports: [{ name: 'mongo', port: 27017 }],
  resources: { limits: { memory: '1Gi', cpu: '1000m' } },
});

describe('a spec that is fine', () => {
  it('accepts the one we already ship', () => {
    // If the validator rejects minio, the rules are wrong, not minio.
    expect(validateSpec(MINIO_SPEC)).toEqual([]);
  });

  it('accepts a minimal stateless app', () => {
    expect(validateSpec(ok())).toEqual([]);
  });
});

describe('the escapes it must refuse', () => {
  it('refuses a host mount or privileged container, at any depth', () => {
    /**
     * Scanned over the whole object rather than field by field: the schema is what is ALLOWED, so
     * anything unrecognised is already suspect — and a `securityContext` smuggled into a nested
     * block would pass a field-by-field check.
     */
    for (const bad of [
      { ...ok(), hostPath: '/' },
      { ...ok(), volumes: [{ path: '/data', size: '1Gi', hostPath: '/etc' }] },
      { ...ok(), resources: { limits: { memory: '1Gi', cpu: '1' }, securityContext: { privileged: true } } },
      { ...ok(), hostNetwork: true },
      { ...ok(), serviceAccountName: 'cluster-admin' },
    ]) {
      expect(validateSpec(bad).length, JSON.stringify(bad).slice(0, 60)).toBeGreaterThan(0);
    }
  });

  it('refuses anything cluster-scoped', () => {
    // Cluster-wide resources affect every other tenant and every other app.
    const problems = validateSpec({ ...ok(), extra: { kind: 'ClusterRoleBinding' } });
    expect(problems.some((p) => /cluster-scoped/.test(p.problem))).toBe(true);
  });

  it('refuses a missing memory limit', () => {
    /**
     * Not defaulted. A default would be silently wrong for every app it did not fit, and the
     * failure — a node evicting unrelated pods — arrives nowhere near the spec that caused it.
     */
    const { resources, ...noLimits } = ok();
    expect(validateSpec(noLimits).some((p) => p.field === 'resources.limits.memory')).toBe(true);
  });
});

describe('the shapes that would fail later, at apply time', () => {
  it('refuses an id that is not a DNS label', () => {
    // The id becomes a namespace, a Service name and a DNS label; an invalid one fails with a
    // message about none of those.
    for (const id of ['Mongo', 'my_app', '-leading', 'trailing-', '']) {
      expect(validateSpec({ ...ok(), id }).some((p) => p.field === 'id'), id).toBe(true);
    }
  });

  it('refuses a spec with no ports', () => {
    // A Service with no ports routes nowhere.
    const { ports, ...none } = ok();
    expect(validateSpec(none).some((p) => p.field === 'ports')).toBe(true);
    expect(validateSpec({ ...ok(), ports: [] }).some((p) => p.field === 'ports')).toBe(true);
  });

  it('refuses an unnamed port, because Services target ports by name', () => {
    expect(validateSpec({ ...ok(), ports: [{ port: 80 }] }).some((p) => /name/.test(p.field))).toBe(true);
  });

  it('refuses a quantity that is not one', () => {
    expect(validateSpec({ ...ok(), resources: { limits: { memory: '1 gigabyte', cpu: '1' } } })
      .some((p) => /quantity/.test(p.problem))).toBe(true);
  });

  it('refuses a relative volume path', () => {
    expect(validateSpec({ ...ok(), volumes: [{ path: 'data', size: '1Gi' }] })
      .some((p) => /absolute/.test(p.problem))).toBe(true);
  });
});

describe('generated credentials', () => {
  it('refuses a value that is both generated and given', () => {
    // Ambiguous about which the container actually receives.
    expect(validateSpec({
      ...ok(),
      env: [{ name: 'PW', generate: 'password', fromSecret: 'pw', value: 'hunter2' }],
    }).length).toBeGreaterThan(0);
  });

  it('refuses a generated value with nowhere to read it from', () => {
    expect(validateSpec({ ...ok(), env: [{ name: 'PW', generate: 'password' }] })
      .some((p) => /fromSecret/.test(p.field))).toBe(true);
  });
});

describe('two generated values sharing one secret key', () => {
  it('refuses it, because the second overwrites the first', () => {
    /**
     * Observed on the first spec Koala wrote: both mongo credentials read `mongo-credentials`, so
     * the container would receive the same string for username and password. Nothing fails — the
     * app starts with a username equal to its password, which is worse than a crash because it
     * works.
     */
    const problems = validateSpec({
      ...ok(),
      env: [
        { name: 'MONGO_INITDB_ROOT_USERNAME', generate: 'username', fromSecret: 'creds' },
        { name: 'MONGO_INITDB_ROOT_PASSWORD', generate: 'password', fromSecret: 'creds' },
      ],
    });
    expect(problems.some((p) => /overwrite each other/.test(p.problem))).toBe(true);
  });

  it('accepts distinct keys', () => {
    expect(validateSpec({
      ...ok(),
      env: [
        { name: 'USER', generate: 'username', fromSecret: 'user' },
        { name: 'PASS', generate: 'password', fromSecret: 'pass' },
      ],
    })).toEqual([]);
  });
});

describe('what the author is told', () => {
  it('reports EVERY problem, not the first', () => {
    /**
     * A spec rejected one line at a time takes as many round trips as it has mistakes, and the
     * thing authoring it is a language model.
     */
    const problems = validateSpec({ id: 'Bad_Name', image: '', ports: [] });
    expect(problems.length).toBeGreaterThan(2);
  });

  it('says nothing when there is nothing to say', () => {
    expect(explainSpecProblems([])).toBe('');
  });

  it('names the field and the reason', () => {
    const text = explainSpecProblems(validateSpec({ ...ok(), id: 'Bad' }));
    expect(text).toContain('id');
    expect(text).toMatch(/lowercase/);
  });

  it('refuses something that is not an object at all', () => {
    for (const bad of [null, 'a spec', 42, []]) {
      expect(validateSpec(bad).length, String(bad)).toBeGreaterThan(0);
    }
  });
});
