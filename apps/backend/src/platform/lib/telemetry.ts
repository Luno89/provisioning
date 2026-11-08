import { context, propagation } from '@opentelemetry/api';
import type { AxiosInstance } from 'axios';
import { envSink, OTLP_ENDPOINT_VAR, type TelemetrySettings } from '@koala/engine-core/telemetry-sdk';

export interface TelemetryPlace {
  version?: string | undefined;
  instanceId?: string | undefined;
  cluster?: string | undefined;
  otlpEndpoint?: string | undefined;
}

export function telemetrySettings(settings: { role: { role: string }; telemetry: TelemetryPlace }, service: string): TelemetrySettings {
  const { version, instanceId, cluster, otlpEndpoint } = settings.telemetry;
  return {
    service,
    role: settings.role.role,
    ...(version ? { version } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(cluster ? { cluster } : {}),
    sink: otlpEndpoint ? envSink({ [OTLP_ENDPOINT_VAR]: otlpEndpoint }) : undefined,
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
