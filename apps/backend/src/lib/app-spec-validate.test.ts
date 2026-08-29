import { describe, it, expect } from 'vitest';
import { validateSpec, explainSpecProblems } from './app-spec-validate.js';
import { MINIO_SPEC } from './app-spec.js';

const ok = () => ({
  id: 'mongo',
  image: 'mongo:7',
  ports: [{ name: 'mongo', port: 27017 }],
  resources: { limits: { memory: '1Gi', cpu: '1000m' } },
});

describe('a spec that is fine', () => {
  it('accepts the one we already ship', () => {
    expect(validateSpec(MINIO_SPEC)).toEqual([]);
  });

  it('accepts a minimal stateless app', () => {
    expect(validateSpec(ok())).toEqual([]);
  });
});

describe('the escapes it must refuse', () => {
  it('refuses a host mount or privileged container, at any depth', () => {
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
    const problems = validateSpec({ ...ok(), extra: { kind: 'ClusterRoleBinding' } });
    expect(problems.some((p) => /cluster-scoped/.test(p.problem))).toBe(true);
  });

  it('refuses a missing memory limit', () => {
    const { resources, ...noLimits } = ok();
    expect(validateSpec(noLimits).some((p) => p.field === 'resources.limits.memory')).toBe(true);
  });
});

describe('the shapes that would fail later, at apply time', () => {
  it('refuses an id that is not a DNS label', () => {
    for (const id of ['Mongo', 'my_app', '-leading', 'trailing-', '']) {
      expect(validateSpec({ ...ok(), id }).some((p) => p.field === 'id'), id).toBe(true);
    }
  });

  it('refuses a spec with no ports', () => {
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
