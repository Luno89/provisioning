import { NativeConnection } from '@temporalio/worker'
import { loadKeys } from './keys.js'
import { TEMPORAL_RENEW_SECONDS, temporalApiKey, temporalNamespaceFrom } from './temporal-auth.js'

export async function connectTemporalWorker(
  address: string,
  subject: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<NativeConnection> {
  const apiKey = temporalApiKey(loadKeys(env).temporal, { subject, namespace: temporalNamespaceFrom(env), role: 'write' })
  const connection = await NativeConnection.connect({ address, tls: false, apiKey: apiKey() })
  const renewing: NodeJS.Timeout = setInterval(() => {
    connection.setApiKey(apiKey()).catch(() => clearInterval(renewing))
  }, (TEMPORAL_RENEW_SECONDS * 1000) / 2)
  renewing.unref()
  return connection
}
