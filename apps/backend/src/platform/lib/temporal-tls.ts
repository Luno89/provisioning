import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

type Env = Readonly<Record<string, string | undefined>>

export const DEV_TEMPORAL_CA = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/temporal-tls/ca.crt')

const caPath = (env: Env): string => env.TEMPORAL_TLS_CA?.trim() || DEV_TEMPORAL_CA

export function temporalCa(env: Env): Buffer | undefined {
  const path = caPath(env)
  return existsSync(path) ? readFileSync(path) : undefined
}

export function temporalTlsProblem(env: Env): string | undefined {
  if (env.NODE_ENV !== 'production' || existsSync(caPath(env))) return undefined
  return `Temporal's certificate authority is not at ${caPath(env)} (TEMPORAL_TLS_CA). In production Koala never talks to Temporal in plaintext: point TEMPORAL_TLS_CA at the CA scripts/temporal-keys.sh made, or the one the instance chart keeps in <release>-temporal-tls`
}

export function temporalTls(env: Env): { serverRootCACertificate: Buffer } | false {
  const ca = temporalCa(env)
  if (ca) return { serverRootCACertificate: ca }
  const problem = temporalTlsProblem(env)
  if (problem) throw new Error(problem)
  return false
}
