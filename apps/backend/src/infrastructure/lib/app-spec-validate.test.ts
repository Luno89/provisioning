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

describe('probes', () => {
  it('are a path and a port, and the Kubernetes shape is named for what it is', () => {
    expect(validateSpec({ ...ok(), liveness: { path: '/', port: 27017 } })).toEqual([]);
    expect(explainSpecProblems(validateSpec({ ...ok(), readiness: { httpGet: { path: '/', port: 80 } } }))).toContain('not the Kubernetes httpGet');
    expect(explainSpecProblems(validateSpec({ ...ok(), liveness: { path: 'health', port: 0 } }))).toMatch(/liveness\.path[\s\S]*liveness\.port/);
  });
});

describe('each rule, broken alone, refused with exactly its own field and words', () => {
  const only = (spec: unknown, field: string, problem: string) => expect(validateSpec(spec)).toEqual([{ field, problem }]);
  const at = (over: Record<string, unknown>) => ({ ...ok(), ...over });

  it('refuses every field that would reach the node or another namespace, wherever in the spec it sits', () => {
    for (const key of ['hostPath', 'hostNetwork', 'hostPID', 'hostIPC', 'privileged', 'capabilities', 'serviceAccount', 'serviceAccountName', 'nodeSelector', 'tolerations', 'hostAliases']) {
      only(at({ [key]: true }), key, 'is not allowed — a spec runs in its own namespace and may not reach the node.');
      only(at({ extra: { deeper: { [key]: true } } }), `extra.deeper.${key}`, 'is not allowed — a spec runs in its own namespace and may not reach the node.');
    }
  });

  it('refuses every cluster-scoped kind, wherever it is named', () => {
    for (const kind of ['ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'PersistentVolume', 'Namespace', 'APIService']) {
      only(at({ extra: { kind } }), 'extra.kind', `"${kind}" is cluster-scoped and would affect every other app.`);
    }
  });

  it('refuses what is not a spec at all', () => {
    for (const raw of [null, [], 'mongo', 7]) expect(validateSpec(raw)).toEqual([{ field: '', problem: 'A spec must be an object.' }]);
  });

  it('refuses a bad name, a missing image and a command that is not a list of words', () => {
    for (const id of ['Mongo', '-mongo', 'mongo-', 'mon_go', 7]) only(at({ id }), 'id', 'must be lowercase letters, digits and hyphens, starting and ending with alphanumeric.');
    for (const image of [undefined, '', '   ', 7]) only(at({ image }), 'image', 'is required.');
    for (const command of ['mongod', ['mongod', 7]]) only(at({ command }), 'command', 'must be an array of strings.');
    expect(validateSpec(at({ command: ['mongod', '--quiet'] }))).toEqual([]);
  });

  it('refuses a config file with no name, content that is not text, or a mount path that is not absolute', () => {
    const file = { name: 'mongod.conf', content: 'quiet: true', mountPath: '/etc/mongod.conf' };
    expect(validateSpec(at({ configFiles: [file] }))).toEqual([]);
    only(at({ configFiles: [{ ...file, name: ' ' }] }), 'configFiles[0].name', 'is required.');
    only(at({ configFiles: [{ ...file, content: 7 }] }), 'configFiles[0].content', 'must be a string.');
    only(at({ configFiles: [{ ...file, mountPath: 'etc/mongod.conf' }] }), 'configFiles[0].mountPath', 'must be an absolute path inside the container.');
  });

  it('refuses no ports, a port outside 1 to 65535 and a port name that is not a lowercase name', () => {
    for (const ports of [undefined, []]) only(at({ ports }), 'ports', 'at least one port is required — a Service with none routes nowhere.');
    for (const port of [0, 65536, '27017']) only(at({ ports: [{ name: 'mongo', port }] }), 'ports[0].port', 'must be a number between 1 and 65535.');
    for (const port of [1, 65535]) expect(validateSpec(at({ ports: [{ name: 'mongo', port }] }))).toEqual([]);
    only(at({ ports: [{ name: 'Mongo', port: 27017 }] }), 'ports[0].name', 'must be a valid lowercase name.');
  });

  it('lets a security context set only the user, group and file group, and refuses anything else in it', () => {
    expect(validateSpec(at({ securityContext: { runAsUser: 999, runAsGroup: 999, fsGroup: 999 } }))).toEqual([]);
    for (const securityContext of ['root', [], null]) only(at({ securityContext }), 'securityContext', 'must be an object.');
    only(at({ securityContext: { allowPrivilegeEscalation: true } }), 'securityContext.allowPrivilegeEscalation', 'is not allowed — only runAsUser, runAsGroup and fsGroup may be set.');
  });

  it('refuses a missing memory or CPU limit, and a size that is not a Kubernetes quantity', () => {
    only(at({ resources: { limits: { cpu: '1' } } }), 'resources.limits.memory', 'is required — an app with no memory limit can take a node down.');
    only(at({ resources: { limits: { memory: '1Gi' } } }), 'resources.limits.cpu', 'is required.');
    only(at({ resources: { limits: { memory: '1 gig', cpu: '1' } } }), 'resources.memory', '"1 gig" is not a Kubernetes quantity (512Mi, 2Gi, 100m).');
    only(at({ resources: { limits: { memory: '1Gi', cpu: '1' }, requests: { cpu: 'lots' } } }), 'resources.cpu', '"lots" is not a Kubernetes quantity (512Mi, 2Gi, 100m).');
    for (const memory of ['512Mi', '2Gi', '1.5G', '1024']) expect(validateSpec(at({ resources: { limits: { memory, cpu: '100m' } } }))).toEqual([]);
  });

  it('refuses a volume with a relative path, an unknown type or medium, or no size where one is needed, and needs none for a plain ephemeral one', () => {
    expect(validateSpec(at({ volumes: [{ path: '/data', type: 'persistent', size: '10Gi' }] }))).toEqual([]);
    expect(validateSpec(at({ volumes: [{ path: '/tmp', type: 'ephemeral' }] }))).toEqual([]);
    expect(validateSpec(at({ volumes: [{ path: '/cache', type: 'ephemeral', medium: 'Memory', size: '1Gi' }] }))).toEqual([]);
    only(at({ volumes: [{ path: 'data', size: '10Gi' }] }), 'volumes[0].path', 'must be an absolute path inside the container.');
    only(at({ volumes: [{ path: '/data', type: 'shared', size: '10Gi' }] }), 'volumes[0].type', 'must be "persistent" or "ephemeral".');
    only(at({ volumes: [{ path: '/tmp', type: 'ephemeral', medium: 'Disk' }] }), 'volumes[0].medium', 'must be "Memory".');
    only(at({ volumes: [{ path: '/data' }] }), 'volumes[0].size', 'must be a size like 10Gi.');
    only(at({ volumes: [{ path: '/cache', type: 'ephemeral', medium: 'Memory' }] }), 'volumes[0].size', 'must be a size like 10Gi.');
  });

  it('refuses an env var with no name, a generated one also given a value or naming no secret key, and two sharing one key', () => {
    only(at({ env: [{ name: ' ', value: 'x' }] }), 'env[0].name', 'is required.');
    only(at({ env: [{ name: 'PASSWORD', generate: true, value: 'x', fromSecret: 'password' }] }), 'env[0]', 'cannot be both generated and given a value.');
    only(at({ env: [{ name: 'PASSWORD', generate: true }] }), 'env[0].fromSecret', 'a generated value must name the secret key it is read from.');
    only(at({ env: [{ name: 'A', fromSecret: 'key' }, { name: 'B', fromSecret: 'key' }] }), 'env[1].fromSecret', '"key" is already used by A — two values sharing a key overwrite each other.');
  });

  it('refuses a probe that is not { path, port }, the Kubernetes shape of one, a relative path or a port outside the range', () => {
    for (const which of ['liveness', 'readiness'] as const) {
      expect(validateSpec(at({ [which]: { path: '/health', port: 8080 } }))).toEqual([]);
      only(at({ [which]: 'ok' }), which, 'must be { path, port }.');
      for (const shape of ['httpGet', 'tcpSocket', 'exec']) only(at({ [which]: { [shape]: {} } }), which, 'is { path, port } here, not the Kubernetes httpGet/tcpSocket/exec shape.');
      only(at({ [which]: { path: 'health', port: 8080 } }), `${which}.path`, 'must be an HTTP path starting with /.');
      for (const port of [0, 65536, 8080.5]) only(at({ [which]: { path: '/health', port } }), `${which}.port`, 'must be a port number.');
    }
  });
});
