import { describe, it, expect } from 'vitest';
import {
  sanitizeNamespace,
  providerFromDeployment,
  providerFromEndpoint,
  listProviders,
  routeProvider,
} from './model-registry.js';
import type { DeploymentMetadata, ModelEndpointMetadata } from './types.js';

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

  it('picks up a tagged deployment the catalogue does not package', () => {
    const p = providerFromDeployment(dep({
      appType: 'gitapp',
      llmApi: { port: 9000, model: 'my-finetune' },
    }));
    expect(p).toMatchObject({ service: 'my-llama-gitapp', port: 9000, model: 'my-finetune' });
    // No engine kind — the platform did not package it and cannot claim to know.
    expect(p?.kind).toBeUndefined();
  });

  it('lets the catalogue WIN over a tag on a known app type', () => {
    // The whole point of the catalogue: platform-packaged values are authoritative, so a stored
    // field cannot quietly repoint a vLLM deployment at another port.
    const p = providerFromDeployment(dep({ llmApi: { port: 9999, serviceSuffix: 'hijacked' } }));
    expect(p).toMatchObject({ service: 'my-llama-vllm', port: 8000 });
  });

  it('ignores a tag with an unusable port rather than forwarding to it', () => {
    expect(providerFromDeployment(dep({ appType: 'gitapp', llmApi: { port: 0 } }))).toBeUndefined();
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

describe('registered endpoints (any OpenAI-compatible API)', () => {
  const ep = (over: Partial<ModelEndpointMetadata> = {}): ModelEndpointMetadata => ({
    id: 'e1',
    ownerId: 'u1',
    name: 'Laptop Ollama',
    baseUrl: 'http://100.64.0.7:11434/v1',
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  });

  it('exposes an endpoint as a provider without cluster fields', () => {
    const p = providerFromEndpoint(ep());
    expect(p).toMatchObject({ source: 'endpoint', baseUrl: 'http://100.64.0.7:11434/v1' });
    expect(p.clusterId).toBeUndefined();
    expect(p.service).toBeUndefined();
  });

  it('never leaks the stored key — only whether one exists', () => {
    const p = providerFromEndpoint(ep({ apiKeyEnc: 'encrypted-blob' }));
    expect(p.hasApiKey).toBe(true);
    expect(JSON.stringify(p)).not.toContain('encrypted-blob');
  });

  it('does not filter on status — the platform does not manage this thing and has no live signal', () => {
    // Unlike a deployment, there is no status to trust. A failed request surfaces the engine's own
    // error, which beats hiding an endpoint because a health check was stale.
    expect(providerFromEndpoint(ep())).toBeTruthy();
  });

  it('treats a blank model as "the endpoint default" rather than inventing one', () => {
    expect(providerFromEndpoint(ep()).model).toBe('');
  });

  it('merges both sources into one list', () => {
    const list = listProviders([dep({ id: 'a' })], [ep({ id: 'e1' })]);
    expect(list.map((p) => [p.id, p.source])).toEqual([
      ['a', 'deployment'],
      ['e1', 'endpoint'],
    ]);
  });

  it('works with no endpoints at all, so existing callers are unaffected', () => {
    expect(listProviders([dep({ id: 'a' })]).map((p) => p.id)).toEqual(['a']);
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

  it('matches on the provider id and never on the model it serves', () => {
    // Why the `model` knob is a picker rather than free text, and why a run must send
    // `provider.model` rather than the override: the override is an id, so passing it along as the
    // model name asked the API for a model called "dep-a". Anything else here does not resolve at
    // all, which is the error people actually hit when they typed a model name in.
    const served = listProviders([dep({ id: 'dep-a', vllmModel: 'Qwen3-32B' })]);
    expect(routeProvider(served, 'dep-a')?.model).toBe('Qwen3-32B');
    expect(routeProvider(served, 'Qwen3-32B')).toBeUndefined();
  });
});
