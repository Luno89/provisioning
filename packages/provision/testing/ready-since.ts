import { expect } from 'vitest';

const READY_START = Date.parse('2026-11-05T10:00:00Z');

const at = (ms: number): string => new Date(ms).toISOString();

export function expectReadyOnlySinceStart(readySince: (answer: string, since: number) => boolean): void {
  expect(readySince(`True ${at(READY_START + 1)}`, READY_START)).toBe(true);
  expect(readySince(`True ${at(READY_START - 1)}`, READY_START)).toBe(false);
  expect(readySince(`False ${at(READY_START + 1)}`, READY_START)).toBe(false);
  expect(readySince('', READY_START)).toBe(false);
}
