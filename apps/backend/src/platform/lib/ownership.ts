
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
    if (r.ownerId != null) continue;
    const k = key(r);
    seen.add(k);
    out.push(mine.get(k) ?? r);
  }
  for (const [k, r] of mine) {
    if (!seen.has(k)) out.push(r);
  }
  return out;
}
