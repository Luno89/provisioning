export interface Off { readonly off: string }

export const isOff = (value: unknown): value is Off =>
  typeof value === 'object' && value !== null && typeof (value as { off?: unknown }).off === 'string';
