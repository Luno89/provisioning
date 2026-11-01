import { expect } from 'vitest';

export const matching = (pattern: string | RegExp): unknown => expect.stringMatching(pattern);

export const containing = (text: string): unknown => expect.stringContaining(text);

export const anyOf = (type: unknown): unknown => expect.any(type);

export const objectWith = (shape: Record<string, unknown>): unknown => expect.objectContaining(shape);

export const arrayWith = (items: unknown[]): unknown => expect.arrayContaining(items);

export const at = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>((inside, step) => (inside !== null && typeof inside === 'object' ? (inside as Record<string | number, unknown>)[step] : undefined), value);
