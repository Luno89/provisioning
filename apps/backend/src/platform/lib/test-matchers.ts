import { expect } from 'vitest';

export const matching = (pattern: string | RegExp): unknown => expect.stringMatching(pattern);

export const containing = (text: string): unknown => expect.stringContaining(text);

export const anyOf = (type: unknown): unknown => expect.any(type);

export const objectWith = (shape: Record<string, unknown>): unknown => expect.objectContaining(shape);

export const arrayWith = (items: unknown[]): unknown => expect.arrayContaining(items);
