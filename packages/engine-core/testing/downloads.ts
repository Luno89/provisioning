export const DOWNLOADS_VARIABLE = 'KOALA_TEST_DOWNLOADS';

export function testDownloads(): string {
  const dir = process.env[DOWNLOADS_VARIABLE];
  if (!dir) throw new Error(`${DOWNLOADS_VARIABLE} is not set: the test world sets it to the folder downloads are kept in across runs, so this is not running under a test tier`);
  return dir;
}

export const temporalServerExecutable = (): { type: 'cached-download'; downloadDir: string } => ({ type: 'cached-download', downloadDir: testDownloads() });
