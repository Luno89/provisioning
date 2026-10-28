import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEV_TEMPORAL_TLS = fileURLToPath(new URL('../../apps/backend/data/temporal-tls', import.meta.url));

export function devTemporalCa(): string[] {
  if (!existsSync(`${DEV_TEMPORAL_TLS}/ca.crt`)) throw new Error(`the dev stack's Temporal has no certificate at ${DEV_TEMPORAL_TLS}: run bash scripts/ensure-temporal.sh`);
  return ['-v', `${DEV_TEMPORAL_TLS}/ca.crt:/etc/koala/temporal-tls/ca.crt:ro`, '-e', 'TEMPORAL_TLS_CA=/etc/koala/temporal-tls/ca.crt'];
}
