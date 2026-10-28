import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export const DEV_TEMPORAL_CA = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/temporal-tls/ca.crt')

export function temporalCa(env: Readonly<Record<string, string | undefined>> = process.env): Buffer | undefined {
  const path = env.TEMPORAL_TLS_CA?.trim() || DEV_TEMPORAL_CA
  return existsSync(path) ? readFileSync(path) : undefined
}

export function temporalTls(env: Readonly<Record<string, string | undefined>> = process.env): { serverRootCACertificate: Buffer } | false {
  const ca = temporalCa(env)
  return ca ? { serverRootCACertificate: ca } : false
}
