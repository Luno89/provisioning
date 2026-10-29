import { describe, expect, it } from 'vitest';
import { commandSafeCode } from './invite-codes.js';

describe('a code handed to a shell command', () => {
  it('never starts with a dash, which an installer would read as an option', () => {
    const dashFirst = () => Buffer.from([0xf8, 0x01, 0x02]);
    expect(Buffer.from([0xf8, 0x01, 0x02]).toString('base64url').startsWith('-')).toBe(true);
    expect(commandSafeCode(3, dashFirst).startsWith('-')).toBe(false);
    expect(commandSafeCode(3, dashFirst)).toHaveLength(4);
  });

  it('keeps its length and alphabet', () => {
    for (let i = 0; i < 200; i += 1) expect(commandSafeCode(24)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{31}$/);
  });
});
