import { sanitizeNamespace } from '../../models/lib/model-registry.js';
import { cacheFolderProblem } from '../../models/lib/tabby-cache-path.js';

const NAMESPACE_MAX = 63;

export const namespaceOf = (dep: { name: string; namespace?: string | undefined }): string => dep.namespace || sanitizeNamespace(dep.name);

export function newAppNamespace(name: string, id: string): string {
  const tag = id.replace(/-/g, '').slice(0, 6).toLowerCase();
  const room = NAMESPACE_MAX - tag.length - 1;
  const base = sanitizeNamespace(name).slice(0, room).replace(/-+$/, '') || 'app';
  return `${base}-${tag}`;
}

export const sameOwner = (a: { ownerId?: string | undefined }, ownerId: string | undefined): boolean => (a.ownerId ?? undefined) === (ownerId ?? undefined);

export const MADE_BY_KOALA_APP_TYPES: ReadonlySet<string> = new Set(['gitapp', 'odoo-project']);

export function deployRequestFrom(body: unknown): { request: Record<string, unknown> } | { problem: string } {
  const { namespace: _namespace, id: _id, ...request } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof request.appType === 'string' && MADE_BY_KOALA_APP_TYPES.has(request.appType)) {
    return { problem: `a ${request.appType} app is made by Koala from its project, never deployed by hand` };
  }
  const cache = cacheFolderProblem(request.tabbyCachePvc) ?? cacheFolderProblem(request.vllmCachePvc);
  if (cache) return { problem: cache };
  return { request };
}

export function platformNamespaceProblem(namespace: string, platform: ReadonlySet<string>): string | undefined {
  return platform.has(namespace) || namespace === 'default' || namespace.startsWith('kube-')
    ? `${namespace} is the platform's own namespace, so this app is not destroyed there; nothing was deleted`
    : undefined;
}
