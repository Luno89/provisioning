import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedBinary, temporalServerExecutable, temporalTestServerExecutable } from './shared.js';

describe('the Temporal binaries the tests run', () => {
  it('are the ones npm run setup put in the checkout\'s bin folder, at the version the pins name', () => {
    const bin = mkdtempSync(join(tmpdir(), 'koala-bin-'));
    writeFileSync(join(bin, 'temporal-1.10.1'), '');
    expect(pinnedBinary('temporal', '1.10.1', bin)).toEqual({ type: 'existing-path', path: join(bin, 'temporal-1.10.1') });
  });

  it('are an error naming npm run setup when it has not put them there, never a download', () => {
    const bin = mkdtempSync(join(tmpdir(), 'koala-bin-'));
    expect(() => pinnedBinary('temporal-test-server', '1.41.1', bin)).toThrow(`${join(bin, 'temporal-test-server-1.41.1')} is not there: run npm run setup, which fetches temporal-test-server 1.41.1 as the pins file names it and checks its sha256`);
  });

  it('name an existing path for both servers, so the SDK fetches nothing', () => {
    expect(temporalServerExecutable().type).toBe('existing-path');
    expect(temporalTestServerExecutable().type).toBe('existing-path');
  });
});
