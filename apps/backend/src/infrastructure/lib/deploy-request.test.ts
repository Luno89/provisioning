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

describe('definedFields', () => {
  it('leaves out what is undefined and keeps every other value', () => {
    expect(definedFields({ a: 'x', b: undefined, c: 0, d: '' })).toEqual({ a: 'x', c: 0, d: '' });
  });
});
