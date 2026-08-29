export function resolveTabbyCacheHostPath(cachePvc?: string): string {
  if (!cachePvc) return '/var/lib/rancher/tabbyapi-model-cache';
  return cachePvc.startsWith('/') ? cachePvc : `/var/lib/rancher/${cachePvc}`;
}
