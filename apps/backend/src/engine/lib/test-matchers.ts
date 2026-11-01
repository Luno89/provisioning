import { expect } from 'vitest';

export const containing = (text: string): unknown => expect.stringContaining(text);

export const matching = (pattern: string | RegExp): unknown => expect.stringMatching(pattern);

export const objectWith = (fields: Readonly<Record<string, unknown>>): unknown => expect.objectContaining(fields);

export const arrayWith = (items: readonly unknown[]): unknown => expect.arrayContaining([...items]);

export const anyOf = (kind: abstract new (...args: never[]) => unknown): unknown => expect.any(kind);
