import { describe, it, expect } from 'vitest';
import { resolveBindings, bindingFiles, type BindingRequest } from './binding-resolve.js';
import { MINIO_SPEC, type AppSpec } from './app-spec.js';

/**
 * Working out what a project's declared dependencies resolve to.
 *
 * ── WHY THE OWNERSHIP CHECK IS THE FEATURE ──
 * Kubernetes Secrets are namespace-scoped with no supported cross-namespace reference, so binding
 * one service to another means the platform READS a Secret in one namespace and writes something
 * derived from it into another. That is the exact shape of the vulnerability class in "Breaking the
 * Bulkhead" (arxiv 2507.03387): operators whose implemented scope is wider than their declared one
 * let a namespace reach another's secrets.
 *
 * So these tests are mostly about what it REFUSES.
 */

const MONGO_SPEC: AppSpec = {
  id: 'mongo',
  image: 'mongo:7',
  ports: [{ name: 'mongo', port: 27017 }],
  env: [
    { name: 'MONGO_INITDB_ROOT_USERNAME', fromSecret: 'mongo-root-username', generate: 'username' },
    { name: 'MONGO_INITDB_ROOT_PASSWORD', fromSecret: 'mongo-root-password', generate: 'password' },
  ],
  volumes: [{ path: '/data/db', size: '10Gi' }],
  resources: { limits: { memory: '1Gi', cpu: '1000m' } },
};

const deployments = [
  { name: 'spec-mongo', appType: 'mongo', status: 'running', ownerId: 'u1' },
  { name: 'their-mongo', appType: 'mongo', status: 'running', ownerId: 'u2' },
  { name: 'starting-mongo', appType: 'mongo', status: 'deploying', ownerId: 'u1' },
  { name: 'a-game', appType: 'palworld', status: 'running', ownerId: 'u1' },
  // Bindable in kind (qdrant IS a backing service) but built by a construct, so its Service and
  // Secret names are not known. Distinct from a game server, which nothing binds to at all.
  { name: 'from-construct', appType: 'qdrant', status: 'running', ownerId: 'u1' },
];
const specs = [{ id: 'mongo', spec: MONGO_SPEC }, { id: 'minio', spec: MINIO_SPEC }];
const resolve = (needs: BindingRequest[], owner = 'u1') =>
  resolveBindings(needs, deployments, specs, owner);

describe('binding to a service you own', () => {
  it('resolves the address, type and where the credentials live', () => {
    const { bindings } = resolve([{ service: 'spec-mongo' }]);
    expect(bindings).toEqual([{
      name: 'mongo',
      type: 'mongodb',
      host: 'mongo.spec-mongo.svc.cluster.local',
      port: 27017,
      source: {
        secretName: 'mongo-secret',
        namespace: 'spec-mongo',
        // Mapped from the spec's `generate`, not guessed from the key's name.
        keys: { username: 'mongo-root-username', password: 'mongo-root-password' },
      },
    }]);
  });

  it('lets a binding be named, for two of the same kind', () => {
    expect(resolve([{ service: 'spec-mongo', as: 'cache' }]).bindings[0]!.name).toBe('cache');
  });
});

describe('what it refuses', () => {
  it('REFUSES a service belonging to someone else', () => {
    // The security boundary. The filter is applied before anything is matched.
    const { bindings, problems } = resolve([{ service: 'their-mongo' }]);
    expect(bindings).toEqual([]);
    expect(problems[0]).toMatch(/No service named "their-mongo"/);
  });

  it('says the same thing for someone else\'s as for one that does not exist', () => {
    /**
     * A distinct "that is not yours" would confirm the name is real, which is a probe. Both must be
     * indistinguishable.
     */
    const theirs = resolve([{ service: 'their-mongo' }]).problems[0];
    const absent = resolve([{ service: 'no-such-thing' }]).problems[0];
    expect(theirs!.replace('their-mongo', 'X')).toBe(absent!.replace('no-such-thing', 'X'));
  });

  it('refuses something that is not running', () => {
    // Binding to it hands an app an address that answers nothing, and the failure reads as a
    // network problem rather than a missing dependency.
    expect(resolve([{ service: 'starting-mongo' }]).problems[0]).toMatch(/is not running \(deploying\)/);
  });

  it('refuses something nothing binds to', () => {
    expect(resolve([{ service: 'a-game' }]).problems[0]).toMatch(/not a service another app binds to/);
  });

  it('refuses a service no spec created', () => {
    /**
     * A construct names its Service and its Secret its own way. Guessing either produces a binding
     * pointing at nothing — the same reason list_infrastructure reports no address for one.
     */
    expect(resolve([{ service: 'from-construct' }]).problems[0])
      .toMatch(/not created from an app spec/);
  });

  it('refuses two bindings sharing a directory', () => {
    // They would overwrite each other's files.
    const { bindings, problems } = resolve([{ service: 'spec-mongo' }, { service: 'spec-mongo' }]);
    expect(bindings).toHaveLength(1);
    expect(problems[0]).toMatch(/both named "mongo"/);
  });

  it('reports a problem without losing the bindings that DID resolve', () => {
    // One bad name must not fail a deploy that has a good one.
    const { bindings, problems } = resolve([{ service: 'nope' }, { service: 'spec-mongo' }]);
    expect(bindings).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it('ignores an empty request rather than erroring', () => {
    expect(resolve([{ service: '  ' }])).toEqual({ bindings: [], problems: [] });
    expect(resolve([])).toEqual({ bindings: [], problems: [] });
  });
});

describe('the files a binding becomes', () => {
  const [binding] = resolve([{ service: 'spec-mongo' }]).bindings;

  it('always has type, which the spec requires', () => {
    const files = bindingFiles(binding!, {});
    expect(files.type).toBe('mongodb');
    expect(files.host).toBe('mongo.spec-mongo.svc.cluster.local');
    expect(files.port).toBe('27017');
  });

  it('carries only the keys the binding declared', () => {
    /**
     * A binding is the subset needed to connect, not a copy of a service's secrets. Anything else in
     * the source Secret stays in the source namespace.
     */
    const files = bindingFiles(binding!, {
      username: 'koala', password: 'hunter2', 'unrelated-key': 'should not cross',
    });
    expect(files).toEqual({
      type: 'mongodb',
      host: 'mongo.spec-mongo.svc.cluster.local',
      port: '27017',
      username: 'koala',
      password: 'hunter2',
    });
    expect(JSON.stringify(files)).not.toContain('should not cross');
  });

  it('omits a credential the source did not have', () => {
    // A missing key is not an empty string: an app checking for presence must see absence.
    expect(bindingFiles(binding!, { username: 'koala' })).not.toHaveProperty('password');
  });
});
