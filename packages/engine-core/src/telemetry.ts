import os from 'node:os';
import {
  context, metrics, propagation, trace, SpanKind, SpanStatusCode,
  type Attributes, type Context, type Counter, type Histogram, type Meter, type ObservableGauge, type Span, type Tracer,
} from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { JsonMetricsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { Payload } from '@temporalio/common';

export type TelemetrySignal = 'traces' | 'metrics';

export interface TelemetrySink {
  send(signal: TelemetrySignal, body: Uint8Array): Promise<void>;
}

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
export const SECONDS_BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 10, 30, 60, 300, 1800];

const SUCCESS: ExportResult = { code: ExportResultCode.SUCCESS };

type Reporter = { failed(signal: TelemetrySignal, err: unknown): void; recovered(signal: TelemetrySignal): void; dropped(signal: TelemetrySignal): void };

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

class SinkExporter {
  private inFlight: Promise<void> | undefined;

  constructor(private readonly signal: TelemetrySignal, private readonly sinkOf: () => TelemetrySink | undefined, private readonly report: Reporter) {}

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
  readonly sending: SinkExporter;

  constructor(sinkOf: () => TelemetrySink | undefined, report: Reporter) {
    this.sending = new SinkExporter('traces', sinkOf, report);
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
  readonly sending: SinkExporter;

  constructor(sinkOf: () => TelemetrySink | undefined, report: Reporter) {
    this.sending = new SinkExporter('metrics', sinkOf, report);
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

let current: (Telemetry & { tracer: Tracer; meter: Meter; metrics: KoalaMetrics }) | undefined;

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
  const metering = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: measurements, exportIntervalMillis: settings.metricsEveryMs ?? METRICS_EVERY_MS, exportTimeoutMillis: settings.metricsEveryMs ?? METRICS_EVERY_MS })],
  });
  metrics.setGlobalMeterProvider(metering);
  const tracer = trace.getTracer('koala');
  const meter = metrics.getMeter('koala');
  current = {
    service: settings.service,
    get exporting() { return sink !== undefined; },
    exportTo(next) { sink = next; },
    tracer,
    meter,
    metrics: instrumentsOn(meter),
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
      current = undefined;
    },
  };
  return current;
}

export const telemetryStarted = (): boolean => current !== undefined;

export interface KoalaMetrics {
  httpRequestSeconds: Histogram;
  workFailures: Counter;
  workflowsStarted: Counter;
  activitySeconds: Histogram;
  activityRetries: Counter;
  heartbeatGapSeconds: Histogram;
  modelCallSeconds: Histogram;
  modelTokens: Counter;
  modelQueueWaitSeconds: Histogram;
  modelRateLimitPauses: Counter;
  modelConnectionLosses: Counter;
  modelQueued: ObservableGauge;
  toolCallSeconds: Histogram;
  sandboxProvisionSeconds: Histogram;
  imageBuildSeconds: Histogram;
  hubSyncSeconds: Histogram;
  hubChangesSent: Counter;
  mailSent: Counter;
  telemetryRelayed: Counter;
}

const seconds = (meter: Meter, name: string, description: string): Histogram =>
  meter.createHistogram(name, { description, advice: { explicitBucketBoundaries: SECONDS_BUCKETS } });

function instrumentsOn(meter: Meter): KoalaMetrics {
  return {
    httpRequestSeconds: seconds(meter, 'koala_http_request_seconds', 'How long each API request took, by route and status'),
    workFailures: meter.createCounter('koala_work_failures', { description: 'Top-level work that ended failed, by kind' }),
    workflowsStarted: meter.createCounter('koala_workflows_started', { description: 'Workflows started, by type' }),
    activitySeconds: seconds(meter, 'koala_activity_seconds', 'How long each activity attempt took, by type and outcome'),
    activityRetries: meter.createCounter('koala_activity_retries', { description: 'Activity attempts after the first, by type' }),
    heartbeatGapSeconds: seconds(meter, 'koala_activity_heartbeat_gap_seconds', 'Heartbeats that came later than expected, by how late'),
    modelCallSeconds: seconds(meter, 'koala_model_call_seconds', 'How long each model call took, by provider, model and outcome'),
    modelTokens: meter.createCounter('koala_model_tokens', { description: 'Tokens the models read and wrote, by provider, model and kind' }),
    modelQueueWaitSeconds: seconds(meter, 'koala_model_queue_wait_seconds', 'How long a model call waited for its turn, by provider'),
    modelRateLimitPauses: meter.createCounter('koala_model_rate_limit_pauses', { description: 'Times a model server said it was busy, by provider' }),
    modelConnectionLosses: meter.createCounter('koala_model_connection_losses', { description: 'Model calls whose connection was lost and asked again, by provider' }),
    modelQueued: meter.createObservableGauge('koala_model_queued', { description: 'Calls waiting for their turn at a model, by provider' }),
    toolCallSeconds: seconds(meter, 'koala_tool_call_seconds', 'How long each tool call took, by tool and outcome'),
    sandboxProvisionSeconds: seconds(meter, 'koala_sandbox_provision_seconds', 'How long a run waited for its sandbox, by outcome'),
    imageBuildSeconds: seconds(meter, 'koala_image_build_seconds', 'How long an image build took, by kind and outcome'),
    hubSyncSeconds: seconds(meter, 'koala_hub_sync_seconds', 'How long each hub sync step took, by step'),
    hubChangesSent: meter.createCounter('koala_hub_changes_sent', { description: 'Changes sent to the hub' }),
    mailSent: meter.createCounter('koala_mail_sent', { description: 'Emails sent, by way and outcome' }),
    telemetryRelayed: meter.createCounter('koala_telemetry_relayed', { description: 'Telemetry batches relayed from machines, by signal and outcome' }),
  };
}

export const koalaMetrics = (): KoalaMetrics => current?.metrics ?? instrumentsOn(metrics.getMeter('koala'));

export const koalaTracer = (): Tracer => current?.tracer ?? trace.getTracer('koala');

export const elapsedSeconds = (startedAt: number): number => (Date.now() - startedAt) / 1000;

export const errorType = (err: unknown): string => (err instanceof Error ? err.constructor.name : typeof err);

export async function withSpan<T>(name: string, attributes: Attributes, run: (span: Span) => Promise<T>, kind: SpanKind = SpanKind.INTERNAL): Promise<T> {
  const span = koalaTracer().startSpan(name, { kind, attributes });
  try {
    const value = await context.with(trace.setSpan(context.active(), span), () => run(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return value;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorType(err));
    throw err;
  } finally {
    span.end();
  }
}

export const currentTraceId = (): string | undefined => {
  const span = trace.getSpan(context.active());
  const id = span?.spanContext().traceId;
  return id && id !== '00000000000000000000000000000000' ? id : undefined;
};

export const TRACE_HEADERS = ['traceparent', 'tracestate'] as const;

const utf8 = new TextEncoder();
const text = new TextDecoder();

export const headerPayload = (value: string): Payload => ({ metadata: { encoding: utf8.encode('json/plain') }, data: utf8.encode(JSON.stringify(value)) });

export function textOfHeader(payload: Payload | undefined): string | undefined {
  if (!payload?.data) return undefined;
  try {
    const parsed = JSON.parse(text.decode(payload.data)) as unknown;
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function tracingHeaders(from: Context = context.active()): Record<string, Payload> {
  const carrier: Record<string, string> = {};
  propagation.inject(from, carrier);
  return Object.fromEntries(TRACE_HEADERS.filter((name) => carrier[name]).map((name) => [name, headerPayload(carrier[name]!)]));
}

export function contextFromHeaders(headers: Record<string, Payload> | undefined): Context {
  const carrier: Record<string, string> = {};
  for (const name of TRACE_HEADERS) {
    const value = textOfHeader(headers?.[name]);
    if (value) carrier[name] = value;
  }
  return propagation.extract(context.active(), carrier);
}

interface WorkflowStartLike {
  workflowType: string;
  headers: Record<string, Payload>;
  options: { workflowId: string; taskQueue?: string | undefined };
}

type Next<I, R> = (input: I) => Promise<R>;

export function traceWorkflowStarts() {
  const around = async <I extends WorkflowStartLike, R>(input: I, next: Next<I, R>): Promise<R> =>
    withSpan(`workflow.start ${input.workflowType}`, {
      'temporal.workflow.type': input.workflowType,
      'temporal.workflow.id': input.options.workflowId,
      ...(input.options.taskQueue ? { 'temporal.task_queue': input.options.taskQueue } : {}),
    }, async () => {
      koalaMetrics().workflowsStarted.add(1, { 'workflow.type': input.workflowType });
      return next({ ...input, headers: { ...input.headers, ...tracingHeaders() } });
    }, SpanKind.PRODUCER);
  return {
    start: around,
    startWithDetails: around,
    signalWithStart: around,
  };
}

interface ActivityInfoLike {
  activityType: string;
  attempt: number;
  taskQueue: string;
  workflowType?: string | undefined;
  workflowExecution?: { workflowId: string; runId: string } | undefined;
}

interface ActivityInputLike {
  headers: Record<string, Payload>;
}

export function traceActivities() {
  return (ctx: { info: ActivityInfoLike }) => ({
    inbound: {
      async execute<I extends ActivityInputLike, R>(input: I, next: Next<I, R>): Promise<R> {
        const { info } = ctx;
        const attributes: Attributes = {
          'temporal.activity.type': info.activityType,
          'temporal.activity.attempt': info.attempt,
          'temporal.task_queue': info.taskQueue,
          ...(info.workflowType ? { 'temporal.workflow.type': info.workflowType } : {}),
          ...(info.workflowExecution ? { 'temporal.workflow.id': info.workflowExecution.workflowId, 'temporal.workflow.run_id': info.workflowExecution.runId } : {}),
        };
        const startedAt = Date.now();
        const measure = (outcome: string) => koalaMetrics().activitySeconds.record(elapsedSeconds(startedAt), { 'activity.type': info.activityType, outcome });
        if (info.attempt > 1) koalaMetrics().activityRetries.add(1, { 'activity.type': info.activityType });
        return context.with(contextFromHeaders(input.headers), () =>
          withSpan(`activity ${info.activityType}`, attributes, async () => {
            try {
              const value = await next(input);
              measure('ok');
              return value;
            } catch (err) {
              measure('failed');
              throw err;
            }
          }, SpanKind.CONSUMER));
      },
    },
  });
}
