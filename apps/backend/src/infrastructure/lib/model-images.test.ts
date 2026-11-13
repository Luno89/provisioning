import { describe, expect, it } from 'vitest';
import { modelImageOf, VLLM_VERSION } from './model-images.js';

describe('the image a model app runs, and its model download with it', () => {
  it('is vLLM\'s pinned build for the GPUs it runs on, or the version the person picked', () => {
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia' })).toBe(`vllm/vllm-openai:${VLLM_VERSION}@sha256:65009b48651a8bc216ab57ed64d7c3d0b0ee8cec77674ccdbcb5f0e8362793a1`);
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'amd' })).toBe(`vllm/vllm-openai-rocm:${VLLM_VERSION}`);
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia', webTag: 'v0.8.0' })).toBe('vllm/vllm-openai:v0.8.0');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia', webTag: 'latest' })).toBe(`vllm/vllm-openai:${VLLM_VERSION}@sha256:65009b48651a8bc216ab57ed64d7c3d0b0ee8cec77674ccdbcb5f0e8362793a1`);
  });

  it('is TabbyAPI\'s pinned build, or the tag the person picked, and none for an app that serves no model', () => {
    expect(modelImageOf({ appType: 'tabbyapi', tabbyImageTag: 'v1.2' })).toBe('ghcr.io/theroyallab/tabbyapi:v1.2');
    expect(modelImageOf({ appType: 'tabbyapi' })).toBe('ghcr.io/theroyallab/tabbyapi@sha256:6c21534292cc4d1393ab3e39e843f7949d01ddadeea051984db09367e328d1d7');
    expect(modelImageOf({ appType: 'wordpress' })).toBeUndefined();
  });
});
