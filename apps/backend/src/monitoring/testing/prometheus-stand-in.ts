import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inCluster } from '../lib/cluster-scope.js';
import type { PromAlert } from '../lib/monitoring-alerts.js';
import { prometheusAt, type PrometheusClient, type Sample } from '../services/MonitoringService.js';

export interface PrometheusStandIn {
  url: string;
  client: PrometheusClient;
  answers: Map<string, Sample[]>;
  series: Map<string, Array<[number, number]>>;
  firing: PromAlert[];
  asked: string[];
  queriesFail: string | undefined;
  scoped(query: string): string;
  set(query: string | undefined, value: number, metric?: Record<string, string>): PrometheusStandIn;
  close(): Promise<void>;
}

const send = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
};

export async function prometheusStandIn(scope?: string): Promise<PrometheusStandIn> {
  const standIn = {
    answers: new Map<string, Sample[]>(),
    series: new Map<string, Array<[number, number]>>(),
    firing: [] as PromAlert[],
    asked: [] as string[],
    queriesFail: undefined as string | undefined,
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://prometheus.test');
    const query = url.searchParams.get('query') ?? '';
    if (url.pathname === '/api/v1/query') {
      standIn.asked.push(query);
      if (standIn.queriesFail !== undefined) return send(response, 503, { status: 'error', errorType: 'unavailable', error: standIn.queriesFail });
      const result = (standIn.answers.get(query) ?? []).map((sample) => ({ metric: sample.metric, value: [Date.now() / 1000, String(sample.value)] }));
      return send(response, 200, { status: 'success', data: { resultType: 'vector', result } });
    }
    if (url.pathname === '/api/v1/query_range') {
      const points = standIn.series.get(query);
      const result = points ? [{ metric: {}, values: points.map(([time, value]) => [time, String(value)]) }] : [];
      return send(response, 200, { status: 'success', data: { resultType: 'matrix', result } });
    }
    if (url.pathname === '/api/v1/alerts') return send(response, 200, { status: 'success', data: { alerts: standIn.firing } });
    return send(response, 404, { status: 'error', errorType: 'not_found', error: `${url.pathname} is not part of Prometheus's API` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scoped = (query: string): string => scope === undefined ? query : inCluster(query, scope);
  const self: PrometheusStandIn = Object.assign(standIn, {
    url,
    client: prometheusAt(url),
    scoped,
    set(query: string | undefined, value: number, metric: Record<string, string> = {}) {
      if (query) standIn.answers.set(scoped(query), [{ metric, value }]);
      return self;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  });
  return self;
}
