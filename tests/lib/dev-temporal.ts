import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('../..', import.meta.url));

export function devCheckout(): string {
  const common = execFileSync('git', ['-C', HERE, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return dirname(resolve(HERE, common));
}

export const devFile = (path: string): string => {
  const own = join(HERE, path);
  return existsSync(own) ? own : join(devCheckout(), path);
};

export const DEV_TEMPORAL_TLS = devFile('apps/backend/data/temporal-tls');

export function devTemporalCa(): string[] {
  if (!existsSync(`${DEV_TEMPORAL_TLS}/ca.crt`)) throw new Error(`the dev stack's Temporal has no certificate at ${DEV_TEMPORAL_TLS}: run bash scripts/ensure-temporal.sh`);
  return ['-v', `${DEV_TEMPORAL_TLS}/ca.crt:/etc/koala/temporal-tls/ca.crt:ro`, '-e', 'TEMPORAL_TLS_CA=/etc/koala/temporal-tls/ca.crt'];
}

export const DEV_SECRET_FILES = ['.gitea-admin-password', '.gitea-admin-token', '.headscale-api-key', '.infisical-admin-password', '.infisical-machine-identity', '.infisical-encryption-key', '.infisical-postgres-password', '.infisical-redis-password'];

export function devDataMounts(files: readonly string[] = DEV_SECRET_FILES): string[] {
  return files.flatMap((file) => {
    const source = devFile(`apps/backend/data/${file}`);
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`the dev stack has no file at ${source} to hand a suite's root; a directory there is one Docker made when it was missing, so remove it`);
    return ['-v', `${source}:/app/apps/backend/data/${file}:ro`];
  });
}
