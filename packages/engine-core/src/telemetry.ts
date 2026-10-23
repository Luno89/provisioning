import {
  context, metrics, propagation, trace, SpanKind, SpanStatusCode,
  type Attributes, type Context, type Counter, type Histogram, type Meter, type ObservableGauge, type Span, type Tracer,
} from '@opentelemetry/api';
import type { Payload } from '@temporalio/common';

export type TelemetrySignal = 'traces' | 'metrics';

export interface TelemetrySink {
  send(signal: TelemetrySignal, body: Uint8Array): Promise<void>;
}

export const SECONDS_BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 10, 30, 60, 300, 1800];
export const UP_METRIC = 'koala_up';
export const INSTRUMENTATION = 'koala';

let started = false;
let cached: KoalaMetrics | undefined;

export const markTelemetryStarted = (value: boolean): void => {
  started = value;
  cached = undefined;
};

export const telemetryStarted = (): boolean => started;

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

export function instrumentsOn(meter: Meter): KoalaMetrics {
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

export function koalaMetrics(): KoalaMetrics {
  if (!started) return instrumentsOn(metrics.getMeter(INSTRUMENTATION));
  cached ??= instrumentsOn(metrics.getMeter(INSTRUMENTATION));
  return cached;
}

export const koalaTracer = (): Tracer => trace.getTracer(INSTRUMENTATION);

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
