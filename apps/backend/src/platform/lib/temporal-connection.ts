import { NativeConnection } from '@temporalio/worker'
import type { PlatformKeys } from './keys.js'
import { TEMPORAL_RENEW_SECONDS, temporalApiKey } from './temporal-auth.js'
import { temporalTls, type TemporalCaPlace } from './temporal-tls.js'

export interface TemporalPlace extends TemporalCaPlace {
  address: string
  namespace: string
}

export async function connectTemporalWorker(
  subject: string,
  settings: { temporal: TemporalPlace; keys: Pick<PlatformKeys, 'temporal'> },
): Promise<NativeConnection> {
  const apiKey = temporalApiKey(settings.keys.temporal, { subject, namespace: settings.temporal.namespace, role: 'write' })
  const connection = await NativeConnection.connect({ address: settings.temporal.address, tls: temporalTls(settings.temporal), apiKey: apiKey() })
  const renewing: NodeJS.Timeout = setInterval(() => {
    connection.setApiKey(apiKey()).catch(() => clearInterval(renewing))
  }, (TEMPORAL_RENEW_SECONDS * 1000) / 2)
  renewing.unref()
  return connection
}
