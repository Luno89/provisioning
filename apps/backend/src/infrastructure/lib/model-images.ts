export const VLLM_VERSION = 'v0.32.0';

export const VLLM_IMAGE = 'vllm/vllm-openai:v0.32.0@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34';

export const VLLM_ROCM_IMAGE = 'vllm/vllm-openai-rocm:v0.32.0@sha256:14f6a575e1fb0a580b0f633c09e06f648709d60405b85f6a7ff3f80d49f39905';

export const TABBYAPI_IMAGE = 'ghcr.io/theroyallab/tabbyapi@sha256:6c21534292cc4d1393ab3e39e843f7949d01ddadeea051984db09367e328d1d7';

export interface ModelApp {
  appType?: string | undefined;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  webTag?: string | undefined;
  tabbyImageTag?: string | undefined;
}

export function modelImageOf(app: ModelApp): string | undefined {
  if (app.appType === 'vllm') {
    const repo = app.vllmGpuVendor === 'amd' ? 'vllm/vllm-openai-rocm' : 'vllm/vllm-openai';
    if (app.webTag && app.webTag !== VLLM_VERSION) return `${repo}:${app.webTag}`;
    return app.vllmGpuVendor === 'amd' ? VLLM_ROCM_IMAGE : VLLM_IMAGE;
  }
  if (app.appType === 'tabbyapi') return app.tabbyImageTag ? `ghcr.io/theroyallab/tabbyapi:${app.tabbyImageTag}` : TABBYAPI_IMAGE;
  return undefined;
}
