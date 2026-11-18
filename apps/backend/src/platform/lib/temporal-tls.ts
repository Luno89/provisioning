import { existsSync, readFileSync } from 'fs'

export interface TemporalCaPlace {
  caPath: string
}

export function temporalTlsProblem(place: TemporalCaPlace): string | undefined {
  if (existsSync(place.caPath)) return undefined
  return `Temporal's certificate authority is not at ${place.caPath} (TEMPORAL_TLS_CA). Koala never talks to Temporal in plaintext: point TEMPORAL_TLS_CA at the CA root-services.ts made in apps/backend/data/temporal-tls, or the one the instance chart keeps in <release>-temporal-tls`
}

export function temporalTls(place: TemporalCaPlace): { serverRootCACertificate: Buffer } {
  const problem = temporalTlsProblem(place)
  if (problem) throw new Error(problem)
  return { serverRootCACertificate: readFileSync(place.caPath) }
}
