import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('../..', import.meta.url));

export function devCheckout(): string {
  if (existsSync(join(HERE, 'apps/backend/.env'))) return HERE;
  const common = execFileSync('git', ['-C', HERE, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return dirname(resolve(HERE, common));
}

export const devFile = (path: string): string => join(devCheckout(), path);

export const DEV_TEMPORAL_TLS = devFile('apps/backend/data/temporal-tls');

export function devTemporalCa(): string[] {
  if (!existsSync(`${DEV_TEMPORAL_TLS}/ca.crt`)) throw new Error(`the dev stack's Temporal has no certificate at ${DEV_TEMPORAL_TLS}: run bash scripts/ensure-temporal.sh`);
  return ['-v', `${DEV_TEMPORAL_TLS}/ca.crt:/etc/koala/temporal-tls/ca.crt:ro`, '-e', 'TEMPORAL_TLS_CA=/etc/koala/temporal-tls/ca.crt'];
}
