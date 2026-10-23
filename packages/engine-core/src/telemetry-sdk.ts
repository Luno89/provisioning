import os from 'node:os';
import { context, metrics, propagation, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { JsonMetricsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { INSTRUMENTATION, markTelemetryStarted, UP_METRIC, type TelemetrySignal, type TelemetrySink } from './telemetry.js';

export type { TelemetrySignal, TelemetrySink } from './telemetry.js';

export interface TelemetrySettings {
  service: string;
  version?: string | undefined;
  role?: string | undefined;
  instanceId?: string | undefined;
  machineId?: string | undefined;
  sink?: TelemetrySink | undefined;
  log?: ((line: string) => void) | undefined;
  spanDelayMs?: number | undefined;
  metricsEveryMs?: number | undefined;
}

export interface Telemetry {
  readonly service: string;
  readonly exporting: boolean;
  exportTo(sink: TelemetrySink | undefined): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const NEVER_MS = 2 ** 31 - 1;
export const SPAN_DELAY_MS = 5_000;
export const METRICS_EVERY_MS = 15_000;
export const OTLP_ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT';

const SUCCESS: ExportResult = { code: ExportResultCode.SUCCESS };

export interface Reporter {
  failed(signal: TelemetrySignal, err: unknown): void;
  recovered(signal: TelemetrySignal): void;
  dropped(signal: TelemetrySignal): void;
}

export function logOnce(log: (line: string) => void): Reporter {
  const down = new Set<TelemetrySignal>();
  const dropping = new Set<TelemetrySignal>();
  return {
    failed(signal, err) {
      if (down.has(signal)) return;
      down.add(signal);
      log(`telemetry: ${signal} are not reaching the collector (${(err as Error)?.message ?? String(err)}); dropping them until it answers`);
    },
    recovered(signal) {
      if (!down.delete(signal)) return;
      log(`telemetry: ${signal} reach the collector again`);
    },
    dropped(signal) {
      if (dropping.has(signal)) return;
      dropping.add(signal);
      log(`telemetry: a batch of ${signal} was dropped while the one before it was still being sent`);
    },
  };
}

class SinkSender {
  private inFlight: Promise<void> | undefined;
  private readonly signal: TelemetrySignal;
  private readonly sinkOf: () => TelemetrySink | undefined;
  private readonly report: Reporter;

  constructor(signal: TelemetrySignal, sinkOf: () => TelemetrySink | undefined, report: Reporter) {
    this.signal = signal;
    this.sinkOf = sinkOf;
    this.report = report;
  }

  deliver(body: Uint8Array | undefined, resultCallback: (result: ExportResult) => void): void {
    const sink = this.sinkOf();
    if (!sink || !body) return resultCallback(SUCCESS);
    if (this.inFlight) {
      this.report.dropped(this.signal);
      return resultCallback(SUCCESS);
    }
    this.inFlight = sink.send(this.signal, body)
      .then(() => this.report.recovered(this.signal), (err: unknown) => this.report.failed(this.signal, err))
      .finally(() => { this.inFlight = undefined; });
    resultCallback(SUCCESS);
  }

  async settle(): Promise<void> {
    await this.inFlight;
  }
}

class SinkSpanExporter implements SpanExporter {
  readonly sending: SinkSender;

  constructor(sinkOf: () => TelemetrySink | undefined, report: Reporter) {
    this.sending = new SinkSender('traces', sinkOf, report);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.sending.deliver(JsonTraceSerializer.serializeRequest(spans), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.sending.settle();
  }

  forceFlush(): Promise<void> {
    return this.sending.settle();
  }
}

class SinkMetricExporter implements PushMetricExporter {
  readonly sending: SinkSender;

  constructor(sinkOf: () => TelemetrySink | undefined, report: Reporter) {
    this.sending = new SinkSender('metrics', sinkOf, report);
  }

  export(resourceMetrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.sending.deliver(JsonMetricsSerializer.serializeRequest(resourceMetrics), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.sending.settle();
  }

  forceFlush(): Promise<void> {
    return this.sending.settle();
  }
}

export function otlpHttpSink(endpoint: () => Promise<string | undefined> | string | undefined, fetchImpl: typeof fetch = fetch): TelemetrySink {
  return {
    async send(signal, body) {
      const base = await endpoint();
      if (!base) throw new Error('no collector is reachable yet');
      const response = await fetchImpl(`${base.replace(/\/+$/, '')}/v1/${signal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(body),
      });
      if (!response.ok) throw new Error(`the collector answered ${response.status}`);
    },
  };
}

export const envSink = (env: Readonly<Record<string, string | undefined>>, fetchImpl: typeof fetch = fetch): TelemetrySink | undefined => {
  const endpoint = env[OTLP_ENDPOINT_VAR]?.trim();
  return endpoint ? otlpHttpSink(() => endpoint, fetchImpl) : undefined;
};

let current: (Telemetry & { tracer: Tracer; meter: Meter }) | undefined;

export function startTelemetry(settings: TelemetrySettings): Telemetry {
  if (current) return current;
  const log = settings.log ?? ((line: string) => console.warn(line));
  const report = logOnce(log);
  let sink = settings.sink;
  const sinkOf = () => sink;
  const resource = resourceFromAttributes({
    'service.name': settings.service,
    'service.instance.id': os.hostname(),
    ...(settings.version ? { 'service.version': settings.version } : {}),
    ...(settings.role ? { 'koala.role': settings.role } : {}),
    ...(settings.instanceId ? { 'koala.instance': settings.instanceId } : {}),
    ...(settings.machineId ? { 'koala.machine': settings.machineId } : {}),
  });
  const spans = new SinkSpanExporter(sinkOf, report);
  const measurements = new SinkMetricExporter(sinkOf, report);
  const tracing = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(spans, { scheduledDelayMillis: settings.spanDelayMs ?? SPAN_DELAY_MS, exportTimeoutMillis: NEVER_MS, maxQueueSize: 4096 })],
  });
  tracing.register();
  const every = settings.metricsEveryMs ?? METRICS_EVERY_MS;
  const metering = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: measurements, exportIntervalMillis: every, exportTimeoutMillis: every })],
  });
  metrics.setGlobalMeterProvider(metering);
  const meter = metrics.getMeter(INSTRUMENTATION);
  meter.createObservableGauge(UP_METRIC, { description: 'One for every Koala process that reports' }).addCallback((observed) => observed.observe(1));
  markTelemetryStarted(true);
  current = {
    service: settings.service,
    get exporting() { return sink !== undefined; },
    exportTo(next) { sink = next; },
    tracer: trace.getTracer(INSTRUMENTATION),
    meter,
    async flush() {
      await tracing.forceFlush();
      await metering.forceFlush();
      await spans.sending.settle();
      await measurements.sending.settle();
    },
    async shutdown() {
      await tracing.shutdown();
      await metering.shutdown();
      await spans.sending.settle();
      await measurements.sending.settle();
      metrics.disable();
      trace.disable();
      context.disable();
      propagation.disable();
      markTelemetryStarted(false);
      current = undefined;
    },
  };
  return current;
}
