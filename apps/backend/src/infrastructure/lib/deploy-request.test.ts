import { describe, expect, it } from 'vitest';
import { definedFields, deployRequestOf, DeployRequestProblem } from './deploy-request.js';

describe('a deploy request read from what was sent', () => {
  it('keeps the fields a deployment has, by their kind, and leaves out the rest', () => {
    expect(deployRequestOf({
      name: 'shop', clusterId: 'c1', appType: 'vllm', strategy: 'native', vllmGpuCount: 2, vllmToolCallingEnabled: true,
      modules: ['sale'], storage: { data: '10Gi' }, palworldPlayers: '16',
    })).toEqual({ name: 'shop', clusterId: 'c1', appType: 'vllm', strategy: 'native', vllmGpuCount: 2, vllmToolCallingEnabled: true, modules: ['sale'], storage: { data: '10Gi' } });
  });

  it('reads the numbers a form sends as text as numbers, and an empty field as not given', () => {
    expect(deployRequestOf({ name: 'tabby', tabbyMaxSeqLen: '32768', vllmGpuMemUtil: '', vllmToolCallParser: '', tabbyReasoning: 'true' }))
      .toEqual({ name: 'tabby', tabbyMaxSeqLen: 32768, tabbyReasoning: true });
  });

  it('refuses a field of the wrong kind, saying which and what it should be', () => {
    expect(() => deployRequestOf({ vllmGpuCount: 'two' })).toThrow(DeployRequestProblem);
    expect(() => deployRequestOf({ vllmDtype: 'int3' })).toThrow(/vllmDtype should be one of auto, half/);
    expect(() => deployRequestOf({ storage: { data: 10 } })).toThrow(/storage should be names with text values/);
  });
});

describe('a model server\'s request', () => {
  it('takes its GPUs, vendor, token and image only in their own fields, refusing another app\'s image and database fields', () => {
    for (const appType of ['vllm', 'tabbyapi']) {
      for (const field of ['odooRepo', 'odooTag', 'pgRepo', 'pgTag', 'dbRepo', 'dbTag']) {
        expect(() => deployRequestOf({ appType, [field]: 'hf_secret' })).toThrow(new RegExp(`a model server takes no ${field}`));
      }
    }
    expect(deployRequestOf({ appType: 'vllm', vllmGpuCount: 1, vllmGpuVendor: 'amd', vllmHfToken: 'hf_secret' }))
      .toEqual({ appType: 'vllm', vllmGpuCount: 1, vllmGpuVendor: 'amd', vllmHfToken: 'hf_secret' });
    expect(deployRequestOf({ appType: 'odoo', odooTag: '18.0', pgTag: '16.4' })).toEqual({ appType: 'odoo', odooTag: '18.0', pgTag: '16.4' });
  });
});

describe('definedFields', () => {
  it('leaves out what is undefined and keeps every other value', () => {
    expect(definedFields({ a: 'x', b: undefined, c: 0, d: '' })).toEqual({ a: 'x', c: 0, d: '' });
  });
});
