import { describe, it, expect } from 'vitest';
import { LLM_APPS, llmAppSpec, isLlmApp, inClusterBaseUrl, specFromTag } from './llm-apps.js';

/**
 * These pin the catalogue against the CDKTF constructs that actually create the Services. The
 * constructs are the ground truth and cannot import from here, so if someone changes a port in
 * constructs/vllm.ts without changing this list, these tests are what notice.
 */
describe('catalogue matches the constructs', () => {
  it('vLLM: <ns>-vllm on 8000 (constructs/vllm.ts Service metadata + port)', () => {
    expect(llmAppSpec('vllm')).toMatchObject({ serviceSuffix: 'vllm', port: 8000, apiPath: '/v1' });
  });

  it('TabbyAPI: <ns>-tabbyapi on 5000 (constructs/tabbyapi.ts)', () => {
    expect(llmAppSpec('tabbyapi')).toMatchObject({ serviceSuffix: 'tabbyapi', port: 5000 });
  });

  it('builds the in-cluster URL the consumers expect', () => {
    expect(inClusterBaseUrl(llmAppSpec('vllm')!, 'my-llama'))
      .toBe('http://my-llama-vllm.my-llama.svc.cluster.local:8000/v1');
    expect(inClusterBaseUrl(llmAppSpec('tabbyapi')!, 'coder'))
      .toBe('http://coder-tabbyapi.coder.svc.cluster.local:5000/v1');
  });

  it('has no duplicate app types', () => {
    const types = LLM_APPS.map((s) => s.appType);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('what is NOT an LLM app', () => {
  it('excludes consumers of a model API', () => {
    // openwebui and hermes TALK to a model rather than serving one. The ternary this catalogue
    // replaced would have handed either of them vLLM's URL via its else-branch.
    expect(isLlmApp('openwebui')).toBe(false);
    expect(isLlmApp('hermes')).toBe(false);
  });

  it('excludes ordinary apps', () => {
    for (const t of ['odoo', 'wordpress', 'nextcloud', 'palworld', 'gitapp']) {
      expect(isLlmApp(t), t).toBe(false);
    }
  });

  it('handles undefined without throwing', () => {
    expect(isLlmApp(undefined)).toBe(false);
    expect(llmAppSpec(undefined)).toBeUndefined();
  });
});

describe('the llmApi escape hatch', () => {
  it('builds a spec for an app type the catalogue does not package', () => {
    const spec = specFromTag({ port: 9000 }, 'gitapp');
    expect(spec).toMatchObject({ serviceSuffix: 'gitapp', port: 9000, apiPath: '/v1' });
  });

  it('accepts an explicit service suffix and path', () => {
    const spec = specFromTag({ port: 9000, serviceSuffix: 'api', apiPath: '/openai/v1' }, 'gitapp');
    expect(inClusterBaseUrl(spec!, 'mine')).toBe('http://mine-api.mine.svc.cluster.local:9000/openai/v1');
  });

  it('rejects a port that is not a usable port number', () => {
    // The one place user input reaches the deployed-app path, so it is validated rather than
    // trusted: a bad value here becomes a port-forward argument.
    for (const port of [0, -1, 70000, 1.5, NaN]) {
      expect(specFromTag({ port }, 'gitapp'), String(port)).toBeUndefined();
    }
  });
});
