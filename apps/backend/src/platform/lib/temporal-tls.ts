import { existsSync, readFileSync } from 'fs'

export interface TemporalCaPlace {
  caPath: string
  production: boolean
}

export function temporalCa(place: TemporalCaPlace): Buffer | undefined {
  return existsSync(place.caPath) ? readFileSync(place.caPath) : undefined
}

export function temporalTlsProblem(place: TemporalCaPlace): string | undefined {
  if (!place.production || existsSync(place.caPath)) return undefined
  return `Temporal's certificate authority is not at ${place.caPath} (TEMPORAL_TLS_CA). In production Koala never talks to Temporal in plaintext: point TEMPORAL_TLS_CA at the CA scripts/temporal-keys.sh made, or the one the instance chart keeps in <release>-temporal-tls`
}

export function temporalTls(place: TemporalCaPlace): { serverRootCACertificate: Buffer } | false {
  const ca = temporalCa(place)
  if (ca) return { serverRootCACertificate: ca }
  const problem = temporalTlsProblem(place)
  if (problem) throw new Error(problem)
  return false
}
