export function mergeRecord<T extends object>(existing: T | undefined, patch: Partial<T>): Partial<T> {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
  return { ...(existing ?? {} as T), ...defined };
}
