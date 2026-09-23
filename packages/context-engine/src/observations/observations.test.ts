import { describe, it, expect } from 'vitest';
import { clampDualBoundary } from './dual-boundary.js';
import { maskToolObservation } from './observation-masker.js';
import { ObservationCache } from './observation-cache.js';

describe('dual boundary output clipping', () => {
  it('leaves output below maxChars untouched', () => {
    const text = 'hello world';
    expect(clampDualBoundary(text, { maxChars: 50 })).toBe('hello world');
  });

  it('preserves both head setup and trailing error stack trace', () => {
    const head = 'npm test\nRunning suite auth.spec.ts...\n';
    const middle = 'x'.repeat(50_000);
    const tail = '\nError: Assertion failed at line 142: expected 200 got 500\nFAILED';
    const full = head + middle + tail;

    const clamped = clampDualBoundary(full, { maxChars: 1000, headRatio: 0.25 });
    expect(clamped).toContain('npm test');
    expect(clamped).toContain('characters omitted from middle');
    expect(clamped).toContain('Assertion failed at line 142');
    expect(clamped).toContain('FAILED');
    expect(clamped.length).toBeLessThan(1200);
  });
});

describe('smart observation masking', () => {
  it('masks file reads into structural receipts', () => {
    const call = { name: 'read_file', arguments: JSON.stringify({ path: 'src/server.ts' }) };
    const result = { content: 'import express from "express";\n'.repeat(100) };

    const masked = maskToolObservation(call, result, { maxChars: 500 });
    expect(masked.content).toContain('File read: "src/server.ts"');
    expect(masked.content).toContain('101 lines');
    expect(masked.content).toContain('content elided');
  });

  it('masks file writes into modification receipts', () => {
    const call = { name: 'write_file', arguments: JSON.stringify({ path: 'src/db.ts', content: 'huge content' }) };
    const result = { content: 'ok' };

    const masked = maskToolObservation(call, result);
    expect(masked.content).toBe('ok'); // short result left intact
  });

  it('NEVER masks away or hides errors or failed executions', () => {
    const call = { name: 'run_command', arguments: JSON.stringify({ command: 'pytest' }) };
    const result = { ok: false, content: 'x'.repeat(10_000) + '\nFAILED test_auth.py::test_login - AssertionError' };

    const masked = maskToolObservation(call, result, { preserveErrors: true });
    expect(masked.ok).toBe(false);
    expect(masked.content).toContain('AssertionError');
    expect(masked.content).toContain('FAILED');
  });

  it('masks grep search results to counts and top files', () => {
    const call = { name: 'grep_search', arguments: JSON.stringify({ query: 'fetchUser' }) };
    const result = { content: 'src/user.ts:12\nsrc/auth.ts:44\nsrc/api.ts:89\n' };

    const masked = maskToolObservation(call, result);
    expect(masked.content).toContain('Search for "fetchUser"');
    expect(masked.content).toContain('3 matches found');
    expect(masked.content).toContain('src/user.ts:12');
  });
});

describe('observation cache', () => {
  it('caches and retrieves raw observations for reversibility', () => {
    const cache = new ObservationCache(5);
    cache.set('obs-1', { toolName: 'read_file', content: 'raw code' });
    expect(cache.has('obs-1')).toBe(true);
    expect(cache.get('obs-1')?.content).toBe('raw code');
  });
});
