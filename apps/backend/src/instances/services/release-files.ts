import { existsSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_TAG = /^[A-Za-z0-9._-]{1,128}$/;

export function inventoryFileFor(chartsDir: string, imageTag: string): string | undefined {
  if (!IMAGE_TAG.test(imageTag)) return undefined;
  const file = join(chartsDir, `${imageTag}.sbom.json`);
  return existsSync(file) ? file : undefined;
}
