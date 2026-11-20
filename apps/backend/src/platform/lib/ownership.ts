
export function ownedBy<T extends { ownerId?: string | undefined }>(
  records: readonly T[],
  userId: string,
): T[] {
  return records.filter((r) => r.ownerId === userId);
}

export { withBuiltIns } from '@koala/agent-engine';
