import { describe, it, expect } from 'vitest';
import {
  sanitizeNamespace,
  providerFromDeployment,
  listProviders,
  routeProvider,
} from './model-registry.js';
import type { DeploymentMetadata } from './types.js';

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata =>
  ({
    id: 'd1',
    name: 'My Llama',
    clusterId: 'c1',
    strategy: 'native',
    appType: 'vllm',
    status: 'running',
    vllmModel: 'meta-llama/Llama-3.1-8B',
    ...over,
  }) as DeploymentMetadata;

describe('sanitizeNamespace', () => {
  it('matches the derivation AppService uses to CREATE the namespace', () => {
    // If these ever drift, the registry port-forwards to a service that does not exist and the
    // failure looks like a timeout rather than a wrong name.
    expect(sanitizeNamespace('My Llama')).toBe('my-llama');
    expect(sanitizeNamespace('Odoo-Production')).toBe('odoo-production');
    expect(sanitizeNamespace('a__b  c')).toBe('a-b-c');
    expect(sanitizeNamespace('-leading-and-trailing-')).toBe('leading-and-trailing');
  });
});

describe('providerFromDeployment', () => {
  it('derives the vLLM service and port from the constructs that create them', () => {
    const p = providerFromDeployment(dep());
    expect(p).toMatchObject({
      namespace: 'my-llama',
      service: 'my-llama-vllm',
      port: 8000,
      kind: 'vllm',
      model: 'meta-llama/Llama-3.1-8B',
    });
  });

  it('derives TabbyAPI on its own port', () => {
    const p = providerFromDeployment(dep({ appType: 'tabbyapi', tabbyModel: 'turboderp/Qwen3' }));
    expect(p).toMatchObject({ service: 'my-llama-tabbyapi', port: 5000, model: 'turboderp/Qwen3' });
  });

  it('excludes app types that serve no OpenAI-compatible API', () => {
    expect(providerFromDeployment(dep({ appType: 'odoo' }))).toBeUndefined();
    expect(providerFromDeployment(dep({ appType: 'openwebui' }))).toBeUndefined();
    // openwebui TALKS to a model but does not serve one — an easy one to wire up backwards.
  });

  it('excludes endpoints that are not running yet', () => {
    // A deploying endpoint accepts a port-forward and then hangs; excluding it here turns a
    // confusing timeout into an absent option.
    expect(providerFromDeployment(dep({ status: 'deploying' }))).toBeUndefined();
    expect(providerFromDeployment(dep({ status: 'failed' }))).toBeUndefined();
    expect(providerFromDeployment(dep({ status: 'destroying' }))).toBeUndefined();
  });

  it('survives a deployment whose model was never recorded', () => {
    // Built without the field rather than with an explicit undefined — exactOptionalPropertyTypes
    // rejects the latter, and the absent case is what actually occurs in the database.
    const { vllmModel: _omitted, ...withoutModel } = dep();
    const p = providerFromDeployment(withoutModel as DeploymentMetadata);
    expect(p?.model).toBe('');
    expect(p?.service).toBe('my-llama-vllm');
  });

  it('rejects a name that sanitizes to nothing rather than building "-vllm"', () => {
    expect(providerFromDeployment(dep({ name: '///' }))).toBeUndefined();
  });
});

describe('listProviders', () => {
  it('keeps only usable endpoints', () => {
    const list = listProviders([
      dep({ id: 'a' }),
      dep({ id: 'b', appType: 'odoo' }),
      dep({ id: 'c', status: 'deploying' }),
      dep({ id: 'd', appType: 'tabbyapi', tabbyModel: 'x' }),
    ]);
    expect(list.map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('returns an empty list rather than throwing when the user has no models', () => {
    // A real state to render — most users start here.
    expect(listProviders([])).toEqual([]);
  });
});

describe('routeProvider', () => {
  const providers = listProviders([dep({ id: 'a' }), dep({ id: 'd', name: 'Second' })]);

  it('honours an explicit selection', () => {
    expect(routeProvider(providers, 'd')?.id).toBe('d');
  });

  it('falls back to the first available when nothing is requested', () => {
    expect(routeProvider(providers)?.id).toBe('a');
  });

  it('returns undefined for an id the user does not own, rather than silently substituting one', () => {
    // The caller passes an ownership-filtered list, so an unmatched id means "not yours". Falling
    // back to a different model would send the prompt somewhere the user did not choose.
    expect(routeProvider(providers, 'someone-elses')).toBeUndefined();
  });

  it('returns undefined when there are no providers at all', () => {
    expect(routeProvider([])).toBeUndefined();
  });
});
