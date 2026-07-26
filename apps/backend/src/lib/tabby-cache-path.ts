/**
 * Keep in sync with packages/cdktf-infra/constructs/tabbyapi.ts's own `cacheHostPath`
 * computation — duplicated for the same reason as model-folder-name.ts (separate npm
 * workspaces). Used by TemporalBridge to tell DownloadModelActivity exactly where on this host
 * to write, matching where the pod's hostPath volume will read from.
 */
export function resolveTabbyCacheHostPath(cachePvc?: string): string {
  if (!cachePvc) return '/var/lib/rancher/tabbyapi-model-cache';
  return cachePvc.startsWith('/') ? cachePvc : `/var/lib/rancher/${cachePvc}`;
}
