export function resolveTabbyCacheHostPath(cachePvc?: string): string {
  if (!cachePvc) return '/var/lib/rancher/tabbyapi-model-cache';
  return cachePvc.startsWith('/') ? cachePvc : `/var/lib/rancher/${cachePvc}`;
}

export function resolveVllmCacheHostPath(cachePvc?: string): string {
  if (!cachePvc) return '/var/lib/rancher/vllm-model-cache';
  return cachePvc.startsWith('/') ? cachePvc : `/var/lib/rancher/${cachePvc}`;
}
