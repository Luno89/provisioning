export const VLLM_VERSION = 'v0.7.2';

export interface ModelApp {
  appType?: string | undefined;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  webTag?: string | undefined;
  tabbyImageTag?: string | undefined;
}

export function modelImageOf(app: ModelApp): string | undefined {
  if (app.appType === 'vllm') {
    const tag = app.webTag && app.webTag !== 'latest' ? app.webTag : VLLM_VERSION;
    return `${app.vllmGpuVendor === 'amd' ? 'vllm/vllm-openai-rocm' : 'vllm/vllm-openai'}:${tag}`;
  }
  if (app.appType === 'tabbyapi') return `ghcr.io/theroyallab/tabbyapi:${app.tabbyImageTag || 'latest'}`;
  return undefined;
}
