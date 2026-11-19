import type { NativeConnection } from '@temporalio/worker'
import { connectTemporal, type TemporalDial } from '@koala/engine-core/temporal'
import type { PlatformKeys } from './keys.js'
import { TEMPORAL_RENEW_SECONDS, temporalApiKey, type TemporalRole } from './temporal-auth.js'
import { temporalTls, type TemporalCaPlace } from './temporal-tls.js'

export interface TemporalPlace extends TemporalCaPlace {
  address: string
  namespace: string
}

export interface TemporalDialSettings {
  temporal: TemporalPlace
  keys: Pick<PlatformKeys, 'temporal'>
}

export function temporalDial(subject: string, settings: TemporalDialSettings, role: TemporalRole = 'write'): TemporalDial {
  return {
    address: settings.temporal.address,
    tls: { ca: temporalTls(settings.temporal).serverRootCACertificate },
    auth: { apiKey: temporalApiKey(settings.keys.temporal, { subject, namespace: settings.temporal.namespace, role }), renewEveryMs: (TEMPORAL_RENEW_SECONDS * 1000) / 2 },
  }
}

export function connectTemporalWorker(subject: string, settings: TemporalDialSettings): Promise<NativeConnection> {
  return connectTemporal(temporalDial(subject, settings), 'worker')
}
