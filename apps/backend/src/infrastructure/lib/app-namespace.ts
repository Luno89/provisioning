import { sanitizeNamespace } from '../../models/lib/model-registry.js';

const NAMESPACE_MAX = 63;

export const namespaceOf = (dep: { name: string; namespace?: string | undefined }): string => dep.namespace || sanitizeNamespace(dep.name);

export function newAppNamespace(name: string, id: string): string {
  const tag = id.replace(/-/g, '').slice(0, 6).toLowerCase();
  const room = NAMESPACE_MAX - tag.length - 1;
  const base = sanitizeNamespace(name).slice(0, room).replace(/-+$/, '') || 'app';
  return `${base}-${tag}`;
}

export const sameOwner = (a: { ownerId?: string | undefined }, ownerId: string | undefined): boolean => (a.ownerId ?? undefined) === (ownerId ?? undefined);
