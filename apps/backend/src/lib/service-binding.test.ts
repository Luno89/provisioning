import { describe, it, expect } from 'vitest';
import {
  bindingFor, bindingTypeFor, describeBindings, bindingProjection, SERVICE_BINDING_ROOT,
} from './service-binding.js';
import { describeInfrastructure } from './infrastructure.js';
import { MINIO_SPEC } from './app-spec.js';

describe('what kind of service something is', () => {
  it('maps the backing services an app could bind to', () => {
    expect(bindingTypeFor('mongo')).toBe('mongodb');
    expect(bindingTypeFor('minio')).toBe('s3');
  });

  it('gives nothing for something that is not a backing service', () => {
    expect(bindingTypeFor('palworld')).toBeUndefined();
    expect(bindingTypeFor('jellyfin')).toBeUndefined();
  });
});

describe('a binding as an app will see it', () => {
  const mongo = bindingFor({
    name: 'mongo', appType: 'mongo', service: 'mongo',
    namespace: 'spec-mongo', port: 27017, keys: ['username', 'password'],
  });

  it('carries the type, which is the one required file', () => {
    expect(mongo?.type).toBe('mongodb');
  });

  it('derives the host rather than inventing it', () => {
    expect(mongo?.host).toBe('mongo.spec-mongo.svc.cluster.local');
  });

  it('names the credential keys but never the values', () => {
    expect(mongo?.keys).toEqual(['username', 'password']);
    expect(JSON.stringify(mongo)).not.toMatch(/password['"]\s*:\s*['"][^'"]{8,}/);
  });

  it('refuses to build one for something with no type', () => {
    expect(bindingFor({ name: 'x', appType: 'palworld', service: 's', namespace: 'n', port: 1 }))
      .toBeUndefined();
  });
});

describe('what an agent is told', () => {
  it('names the root and the files, so nothing has to be guessed', () => {
    const text = describeBindings();
    expect(text).toContain(SERVICE_BINDING_ROOT);
    expect(text).toMatch(/\/type/);
    expect(text).toMatch(/\/host/);
    expect(text).toMatch(/username/);
  });

  it('says never to hard-code an address or a credential', () => {
    expect(describeBindings()).toMatch(/Never hard-code/);
    expect(describeBindings()).toMatch(/never write a\s*\n?\s*credential into a repository/i);
  });

  it('explains the convention even when nothing is bound', () => {
    const text = describeBindings([]);
    expect(text).toContain(SERVICE_BINDING_ROOT);
    expect(text).toMatch(/Nothing is bound to this project yet/);
  });

  it('lists what IS bound, with real values', () => {
    const text = describeBindings([
      { name: 'mongo', type: 'mongodb', host: 'mongo.spec-mongo.svc.cluster.local', port: 27017, keys: ['username', 'password'] },
    ]);
    expect(text).toMatch(/mongo: type=mongodb, host=mongo\.spec-mongo\.svc\.cluster\.local, port=27017/);
    expect(text).toMatch(/username and password/);
  });
});

describe('addresses reported to a planner', () => {
  const deployments = [
    { id: 'd1', name: 'koala-store', appType: 'minio', status: 'running', ownerId: 'u1' },
    { id: 'd2', name: 'from-a-construct', appType: 'searxng', status: 'running', ownerId: 'u1' },
  ];
  const specs = [{ id: 'minio', spec: MINIO_SPEC }];

  it('gives an address for an app a SPEC created', () => {
    const infra = describeInfrastructure(deployments, 'u1', specs);
    const store = infra.running.find((s) => s.name === 'koala-store');
    expect(store?.address).toBe('minio.koala-store.svc.cluster.local:9000');
    expect(store?.bindingType).toBe('s3');
  });

  it('gives NO address for an app a construct created', () => {
    const infra = describeInfrastructure(deployments, 'u1', specs);
    expect(infra.running.find((s) => s.name === 'from-a-construct')?.address).toBeUndefined();
  });

  it('degrades honestly with no catalogue at all', () => {
    const infra = describeInfrastructure(deployments, 'u1');
    expect(infra.running).toHaveLength(2);
    expect(infra.running.every((s) => s.address === undefined)).toBe(true);
  });
});

describe('projecting bindings into a pod', () => {
  const projected = [
    { name: 'mongo', secretName: 'binding-mongo' },
    { name: 'cache', secretName: 'binding-cache' },
  ];

  it('mounts each binding at its own directory under the root', () => {
    const { volumeMounts } = bindingProjection(projected);
    expect(volumeMounts.map((m) => m.mountPath)).toEqual([
      `${SERVICE_BINDING_ROOT}/mongo`,
      `${SERVICE_BINDING_ROOT}/cache`,
    ]);
  });

  it('mounts them READ-ONLY', () => {
    expect(bindingProjection(projected).volumeMounts.every((m) => m.readOnly)).toBe(true);
  });

  it('sets SERVICE_BINDING_ROOT explicitly', () => {
    expect(bindingProjection(projected).env).toEqual([
      { name: 'SERVICE_BINDING_ROOT', value: SERVICE_BINDING_ROOT },
    ]);
  });

  it('names volumes and mounts consistently, or the pod will not start', () => {
    const { volumes, volumeMounts } = bindingProjection(projected);
    expect(volumes.map((v) => v.name)).toEqual(volumeMounts.map((m) => m.name));
  });

  it('carries no credential value — only the Secret to read it from', () => {
    expect(JSON.stringify(bindingProjection(projected))).not.toMatch(/password|username/i);
  });

  it('produces nothing at all for an app with no dependencies', () => {
    expect(bindingProjection([])).toEqual({ volumes: [], volumeMounts: [], env: [] });
  });
});
