export const VLLM_VERSION = 'v0.7.2';

export const VLLM_IMAGE = 'vllm/vllm-openai:v0.7.2@sha256:65009b48651a8bc216ab57ed64d7c3d0b0ee8cec77674ccdbcb5f0e8362793a1';

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
    if (app.webTag && app.webTag !== 'latest') return `${repo}:${app.webTag}`;
    return app.vllmGpuVendor === 'amd' ? `${repo}:${VLLM_VERSION}` : VLLM_IMAGE;
  }
  if (app.appType === 'tabbyapi') return app.tabbyImageTag ? `ghcr.io/theroyallab/tabbyapi:${app.tabbyImageTag}` : TABBYAPI_IMAGE;
  return undefined;
}
