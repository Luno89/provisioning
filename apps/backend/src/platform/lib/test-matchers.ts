import { expect } from 'vitest';

export const matching = (pattern: string | RegExp): unknown => expect.stringMatching(pattern);

export const containing = (text: string): unknown => expect.stringContaining(text);

export const anyOf = (kind: unknown): unknown => expect.any(kind);

export const anything = (): unknown => expect.anything();

export const objectWith = (fields: Readonly<Record<string, unknown>>): unknown => expect.objectContaining(fields);

export const arrayWith = (items: readonly unknown[]): unknown => expect.arrayContaining([...items]);
