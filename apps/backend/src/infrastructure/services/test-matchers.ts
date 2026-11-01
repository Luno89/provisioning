import { expect } from 'vitest';

export const containing = (text: string): unknown => expect.stringContaining(text);
export const matching = (pattern: RegExp | string): unknown => expect.stringMatching(pattern);
export const listContaining = (items: unknown[]): unknown => expect.arrayContaining(items);
export const objectWith = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields);
export const anything = (): unknown => expect.anything();
export const instanceOf = (kind: unknown): unknown => expect.any(kind);
