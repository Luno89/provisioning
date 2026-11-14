import { describe, expect, it } from 'vitest';
import { modelImageOf, VLLM_VERSION } from './model-images.js';

describe('the image a model app runs, and its model download with it', () => {
  it('is vLLM\'s pinned build for the GPUs it runs on, or the version the person picked', () => {
    expect(VLLM_VERSION).toBe('v0.32.0');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia' })).toBe('vllm/vllm-openai:v0.32.0@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'amd' })).toBe('vllm/vllm-openai-rocm:v0.32.0@sha256:14f6a575e1fb0a580b0f633c09e06f648709d60405b85f6a7ff3f80d49f39905');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'amd', webTag: 'latest' })).toBe('vllm/vllm-openai-rocm:v0.32.0@sha256:14f6a575e1fb0a580b0f633c09e06f648709d60405b85f6a7ff3f80d49f39905');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia', webTag: 'v0.8.0' })).toBe('vllm/vllm-openai:v0.8.0');
    expect(modelImageOf({ appType: 'vllm', vllmGpuVendor: 'nvidia', webTag: 'latest' })).toBe('vllm/vllm-openai:v0.32.0@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34');
  });

  it('is TabbyAPI\'s pinned build, or the tag the person picked, and none for an app that serves no model', () => {
    expect(modelImageOf({ appType: 'tabbyapi', tabbyImageTag: 'v1.2' })).toBe('ghcr.io/theroyallab/tabbyapi:v1.2');
    expect(modelImageOf({ appType: 'tabbyapi' })).toBe('ghcr.io/theroyallab/tabbyapi@sha256:6c21534292cc4d1393ab3e39e843f7949d01ddadeea051984db09367e328d1d7');
    expect(modelImageOf({ appType: 'wordpress' })).toBeUndefined();
  });
});
