
export interface OwnershipUser {
  id: string;
  isAdmin?: boolean | undefined;
}

export interface OwnedRecord {
  ownerId?: string | undefined;
  [key: string]: unknown;
}

export function ownsProject<T extends OwnedRecord>(
  project: T | null | undefined,
  user: OwnershipUser,
): boolean {
  return project?.ownerId ? project.ownerId === user.id : user.isAdmin === true;
}

export function clusterVisible<T extends OwnedRecord & { isSystem?: boolean | undefined }>(
  cluster: T | null | undefined,
  userId: string,
): boolean {
  return !!cluster && (cluster.isSystem === true || cluster.ownerId === userId);
}

export function ownedBy<T extends { ownerId?: string | undefined }>(
  records: readonly T[],
  userId: string,
): T[] {
  return records.filter((r) => r.ownerId === userId);
}

export function withBuiltIns<T extends { ownerId?: string | undefined }>(
  records: readonly T[],
  userId: string,
  key: (record: T) => string,
): T[] {
  const mine = new Map<string, T>();
  for (const r of records) {
    if (r.ownerId === userId) mine.set(key(r), r);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.ownerId !== undefined) continue;
    const k = key(r);
    seen.add(k);
    out.push(mine.get(k) ?? r);
  }
  for (const [k, r] of mine) {
    if (!seen.has(k)) out.push(r);
  }
  return out;
}
