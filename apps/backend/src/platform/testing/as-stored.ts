const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

export function asStored<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => (item === undefined ? null : asStored(item))) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, asStored(item)])) as T;
  return structuredClone(value);
}
