import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_VARIABLE = 'KOALA_TEST_SHARED';

export const sharedTmp = (): string => process.env[SHARED_VARIABLE] ?? tmpdir();

const CHECKOUT_BIN = fileURLToPath(new URL('../../../bin', import.meta.url));

export interface PinnedBinary {
  type: 'existing-path';
  path: string;
}

export function pinnedBinary(name: string, version: string, bin: string = CHECKOUT_BIN): PinnedBinary {
  const path = join(bin, `${name}-${version}`);
  if (!existsSync(path)) throw new Error(`${path} is not there: run npm run setup, which fetches ${name} ${version} as the pins file names it and checks its sha256`);
  return { type: 'existing-path', path };
}

export const TEMPORAL_CLI_VERSION = '1.10.1';

export const TEMPORAL_TEST_SERVER_VERSION = '1.41.1';

export const temporalServerExecutable = (): PinnedBinary => pinnedBinary('temporal', TEMPORAL_CLI_VERSION);

export const temporalTestServerExecutable = (): PinnedBinary => pinnedBinary('temporal-test-server', TEMPORAL_TEST_SERVER_VERSION);
