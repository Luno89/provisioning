import {
  APP_CHARTS, APP_QUESTIONS, CLUSTER_CHARTS, CLUSTER_QUESTIONS, KOALA_QUESTIONS, USAGES, WINDOW_QUESTIONS, appChartQuery, appQuery, appWindowQuery,
  clusterChartQuery, clusterQuery, koalaQuery, koalaServicesQuery, usageQuery,
  type AppChart, type AppQuestion, type AppSubject, type ClusterChart, type ClusterQuestion, type KoalaQuestion, type PoolPlace, type Usage, type WindowQuestion,
} from './monitoring-questions.js';

export type MonitoringAsk =
  | { kind: 'app'; question: AppQuestion; subject: AppSubject }
  | { kind: 'window'; question: WindowQuestion; subject: AppSubject; seconds: number }
  | { kind: 'cluster'; question: ClusterQuestion }
  | { kind: 'appChart'; chart: AppChart; subject: AppSubject }
  | { kind: 'clusterChart'; chart: ClusterChart }
  | { kind: 'usage'; of: Usage }
  | { kind: 'services'; namespace: string }
  | { kind: 'koala'; question: KoalaQuestion }
  | { kind: 'koalaServices' };

export interface RangeAsk {
  start: number;
  end: number;
  step: number;
}

export function askQuery(ask: MonitoringAsk, place?: PoolPlace): string | undefined {
  switch (ask.kind) {
    case 'app': return appQuery(ask.question, ask.subject, place);
    case 'window': return appWindowQuery(ask.question, ask.subject, ask.seconds, place);
    case 'cluster': return clusterQuery(ask.question, place);
    case 'appChart': return appChartQuery(ask.chart, ask.subject, place);
    case 'clusterChart': return clusterChartQuery(ask.chart, place);
    case 'usage': return usageQuery(ask.of, place);
    case 'services': return place ? undefined : `kube_service_info{namespace=${JSON.stringify(ask.namespace)}}`;
    case 'koala': return place ? undefined : koalaQuery(ask.question);
    case 'koalaServices': return place ? undefined : koalaServicesQuery();
  }
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const MAX_SECONDS = 400 * 86_400;
const MAX_POINTS = 11_000;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

function subjectFrom(value: unknown): AppSubject | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { namespace, services } = value as { namespace?: unknown; services?: unknown };
  if (typeof namespace !== 'string' || !NAME.test(namespace)) return undefined;
  if (services === undefined) return { namespace };
  if (!Array.isArray(services) || services.length > 50 || !services.every((entry) => typeof entry === 'string' && NAME.test(entry))) return undefined;
  return { namespace, services: services as string[] };
}

export function parseAsk(value: unknown): MonitoringAsk | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  switch (body.kind) {
    case 'app': {
      const subject = subjectFrom(body.subject);
      return subject && oneOf(APP_QUESTIONS, body.question) ? { kind: 'app', question: body.question, subject } : undefined;
    }
    case 'window': {
      const subject = subjectFrom(body.subject);
      const seconds = body.seconds;
      if (!subject || !oneOf(WINDOW_QUESTIONS, body.question) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > MAX_SECONDS) return undefined;
      return { kind: 'window', question: body.question, subject, seconds };
    }
    case 'cluster': return oneOf(CLUSTER_QUESTIONS, body.question) ? { kind: 'cluster', question: body.question } : undefined;
    case 'appChart': {
      const subject = subjectFrom(body.subject);
      return subject && oneOf(APP_CHARTS, body.chart) ? { kind: 'appChart', chart: body.chart, subject } : undefined;
    }
    case 'clusterChart': return oneOf(CLUSTER_CHARTS, body.chart) ? { kind: 'clusterChart', chart: body.chart } : undefined;
    case 'usage': return oneOf(USAGES, body.of) ? { kind: 'usage', of: body.of } : undefined;
    case 'services': return typeof body.namespace === 'string' && NAME.test(body.namespace) ? { kind: 'services', namespace: body.namespace } : undefined;
    case 'koala': return oneOf(KOALA_QUESTIONS, body.question) ? { kind: 'koala', question: body.question } : undefined;
    case 'koalaServices': return { kind: 'koalaServices' };
    default: return undefined;
  }
}

export function parseRange(value: unknown): RangeAsk | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { start, end, step } = value as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' || typeof step !== 'number') return undefined;
  if (![start, end, step].every(Number.isFinite) || step < 15 || end <= start || end - start > MAX_SECONDS || (end - start) / step > MAX_POINTS) return undefined;
  return { start, end, step };
}
