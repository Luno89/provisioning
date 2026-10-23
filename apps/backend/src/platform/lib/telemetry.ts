import { context, propagation } from '@opentelemetry/api';
import type { AxiosInstance } from 'axios';
import { envSink, type TelemetrySettings } from '@koala/engine-core/telemetry-sdk';

export const SYSTEM_KUBECONFIG = '/tmp/kubeconfig-provisioning-lunorica';
export const VERSION_VAR = 'KOALA_VERSION';

export function telemetrySettings(env: Readonly<Record<string, string | undefined>>, service: string): TelemetrySettings {
  const version = env[VERSION_VAR]?.trim();
  const instanceId = env.INSTANCE_ID?.trim();
  return {
    service,
    role: env.ROLE?.trim() || 'combined',
    ...(version ? { version } : {}),
    ...(instanceId ? { instanceId } : {}),
    sink: envSink(env),
  };
}

export function carryingTrace<T extends Pick<AxiosInstance, 'interceptors'>>(http: T): T {
  http.interceptors.request.use((config) => {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    for (const [name, value] of Object.entries(carrier)) config.headers.set(name, value);
    return config;
  });
  return http;
}
