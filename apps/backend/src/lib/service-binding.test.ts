import { describe, it, expect } from 'vitest';
import {
  bindingFor, bindingTypeFor, describeBindings, bindingProjection, SERVICE_BINDING_ROOT,
} from './service-binding.js';
import { describeInfrastructure } from './infrastructure.js';
import { MINIO_SPEC } from './app-spec.js';

/**
 * How a workload is told where to reach a service it depends on.
 *
 * ── A PUBLIC CONVENTION, NOT ONE WE INVENTED ──
 * servicebinding.io v1.1.0 projects bindings as FILES under `$SERVICE_BINDING_ROOT`, with a
 * required `type`. I was about to invent a `MONGO_URL` env-var convention instead; the spec exists,
 * has client libraries, and moved away from environment variables for a reason worth keeping — a
 * secret in the environment appears in `kubectl describe pod`, in crash dumps, and in anything that
 * logs its own env at startup, and cannot be rotated without a restart.
 */

describe('what kind of service something is', () => {
  it('maps the backing services an app could bind to', () => {
    expect(bindingTypeFor('mongo')).toBe('mongodb');
    expect(bindingTypeFor('minio')).toBe('s3');
  });

  it('gives nothing for something that is not a backing service', () => {
    // A game server or a media library is not something another app connects TO.
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
    // An app reads `type` to tell what it has been handed.
    expect(mongo?.type).toBe('mongodb');
  });

  it('derives the host rather than inventing it', () => {
    expect(mongo?.host).toBe('mongo.spec-mongo.svc.cluster.local');
  });

  it('names the credential keys but never the values', () => {
    /**
     * The values exist only in the cluster. Anything that can read a binding description — a
     * planner, a proposal, a transcript — must not be able to recover a password from it.
     */
    expect(mongo?.keys).toEqual(['username', 'password']);
    expect(JSON.stringify(mongo)).not.toMatch(/password['"]\s*:\s*['"][^'"]{8,}/);
  });

  it('refuses to build one for something with no type', () => {
    // `type` is required by the spec, so a binding without one is not projectable.
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
    // The failure this exists to prevent: an agent that does not know the mechanism exists writes
    // a connection string into the repository instead of asking for one.
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
    // The Service is named after the spec and the port comes from it, so both are facts.
    const infra = describeInfrastructure(deployments, 'u1', specs);
    const store = infra.running.find((s) => s.name === 'koala-store');
    expect(store?.address).toBe('minio.koala-store.svc.cluster.local:9000');
    expect(store?.bindingType).toBe('s3');
  });

  it('gives NO address for an app a construct created', () => {
    /**
     * There is no general answer for those — each construct names its Service its own way. A
     * plausible-looking address is worse than none: it is indistinguishable to a model from one it
     * was told, and sends work at a host that does not resolve.
     */
    const infra = describeInfrastructure(deployments, 'u1', specs);
    expect(infra.running.find((s) => s.name === 'from-a-construct')?.address).toBeUndefined();
  });

  it('degrades honestly with no catalogue at all', () => {
    // Fewer facts, never invented ones.
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
    // A credential an app can edit is one it can corrupt, and nothing should write to a binding.
    expect(bindingProjection(projected).volumeMounts.every((m) => m.readOnly)).toBe(true);
  });

  it('sets SERVICE_BINDING_ROOT explicitly', () => {
    /**
     * The spec says an implementation assigns a value when the variable is absent, so an app that
     * reads it works either way — but one that reads it and finds nothing has to guess, and guessing
     * is what the convention exists to remove.
     */
    expect(bindingProjection(projected).env).toEqual([
      { name: 'SERVICE_BINDING_ROOT', value: SERVICE_BINDING_ROOT },
    ]);
  });

  it('names volumes and mounts consistently, or the pod will not start', () => {
    const { volumes, volumeMounts } = bindingProjection(projected);
    expect(volumes.map((v) => v.name)).toEqual(volumeMounts.map((m) => m.name));
  });

  it('carries no credential value — only the Secret to read it from', () => {
    // The projection says WHERE the files come from. The values never pass through this.
    expect(JSON.stringify(bindingProjection(projected))).not.toMatch(/password|username/i);
  });

  it('produces nothing at all for an app with no dependencies', () => {
    // Which is every app today. An empty volume list must not add an env var either.
    expect(bindingProjection([])).toEqual({ volumes: [], volumeMounts: [], env: [] });
  });
});
