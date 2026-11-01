export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

export const fieldOf = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

export const listAt = (value: unknown, key: string): unknown[] => {
  const found = fieldOf(value, key);
  return Array.isArray(found) ? found : [];
};

export const textAt = (value: unknown, key: string): string | undefined => {
  const found = fieldOf(value, key);
  return typeof found === 'string' ? found : undefined;
};
