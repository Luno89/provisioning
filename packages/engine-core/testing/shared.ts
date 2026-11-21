import { tmpdir } from 'node:os';

export const SHARED_VARIABLE = 'KOALA_TEST_SHARED';

export const sharedTmp = (): string => process.env[SHARED_VARIABLE] ?? tmpdir();

export function testDownloads(): string {
  const dir = process.env[SHARED_VARIABLE];
  if (!dir) throw new Error(`${SHARED_VARIABLE} is not set: the test world sets it to the folder runs share, downloads included, so this is not running under a test tier`);
  return dir;
}

export const temporalServerExecutable = (): { type: 'cached-download'; downloadDir: string; version: string } => ({ type: 'cached-download', downloadDir: testDownloads(), version: 'v1.10.1' });

export const temporalTestServerExecutable = (): { type: 'cached-download'; downloadDir: string; version: string } => ({ type: 'cached-download', downloadDir: testDownloads(), version: 'v1.41.1' });
