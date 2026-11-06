import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = new URL('../../', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');
const yaml = <T>(file: string): T => parse(read(file)) as T;

interface ScrapeConfig { job_name: string; static_configs: Array<{ targets: string[]; labels: Record<string, string> }> }
interface Statements { context: string; statements: string[] }
interface HostCollector {
  receivers: {
    otlp: { protocols: { grpc: { endpoint: string }; http: { endpoint: string } } };
    prometheus: { config: { scrape_configs: ScrapeConfig[] } };
    'tcpcheck/mail': { targets: Array<{ endpoint: string }> };
    'otlpjsonfile/backup': { include: string[]; replay_file: boolean };
  };
  processors: { 'transform/mail': { metric_statements: Statements[] } };
  service: { telemetry: { metrics: { level: string } }; pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }> };
}
interface Compose { services: Record<string, { ports?: string[]; volumes?: string[]; image?: string; environment?: Record<string, string> | string[] }> }

const SERVICES = ['caddy', 'mongo', 'postgres', 'temporal', 'headscale', 'registry', 'mail'];
const config = yaml<HostCollector>('docker/otel/config.yaml');
const scrapes = config.receivers.prometheus.config.scrape_configs;
const metricPorts = /^METRIC_PORTS="([0-9 ]+)"$/m.exec(read('scripts/root-node/root-telemetry.sh'))![1]!.split(' ');
const published = (file: string, service: string): string[] => yaml<Compose>(file).services[service]!.ports ?? [];

describe('the host collector on root', () => {
  it('scrapes each of root\'s services on loopback, every target labelled with exactly one service name', () => {
    const labelled = scrapes.flatMap((scrape) => scrape.static_configs.map((statics) => {
      expect(Object.keys(statics.labels), scrape.job_name).toEqual(['service']);
      for (const target of statics.targets) expect(target, scrape.job_name).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(scrape.job_name).toBe(`koala-${statics.labels.service}`);
      return statics.labels.service!;
    }));
    expect([...labelled, 'mail'].sort()).toEqual([...SERVICES].sort());
  });

  it('gives mail, which serves no metrics, an up series of its own from a TCP check of its port on loopback', () => {
    expect(config.receivers['tcpcheck/mail'].targets).toEqual([{ endpoint: '127.0.0.1:2525' }]);
    const statements = config.processors['transform/mail'].metric_statements.flatMap((group) => group.statements);
    expect(statements).toContain('set(attributes["service"], "mail") where metric.name == "tcpcheck.status"');
    expect(statements).toContain('set(name, "up") where name == "tcpcheck.status"');
    expect(statements).toContain('set(unit, "") where name == "tcpcheck.status"');
    expect(config.service.pipelines['metrics/mail']).toMatchObject({ receivers: ['tcpcheck/mail'], exporters: ['otlp'] });
    expect(config.service.pipelines['metrics/mail']!.processors).toContain('transform/mail');
    expect(config.service.pipelines.metrics!.processors).not.toContain('transform/mail');
  });

  it('reads the backup\'s last success from the file backup.sh writes, again on every poll, so the series never expires', () => {
    expect(config.receivers['otlpjsonfile/backup']).toMatchObject({ include: ['/koala-backup/*.json'], replay_file: true });
    expect(config.service.pipelines.metrics!.receivers).toEqual(['otlp', 'prometheus', 'otlpjsonfile/backup']);
    expect(yaml<Compose>('docker-compose.otel.yml').services.otel!.volumes).toContain('/var/lib/koala-backup/metrics:/koala-backup:ro');
    expect(read('scripts/root-node/backup.sh')).toMatch(/^METRICS_DIR=\/var\/lib\/koala-backup\/metrics$/m);
    expect(read('scripts/root-node/backup.sh')).toContain('"name":"koala_root_backup_last_success_seconds"');
  });

  it('listens only on loopback and opens no port of its own for its own metrics', () => {
    expect(config.receivers.otlp.protocols.grpc.endpoint).toBe('127.0.0.1:4317');
    expect(config.receivers.otlp.protocols.http.endpoint).toBe('127.0.0.1:4318');
    expect(config.service.telemetry.metrics.level).toBe('none');
  });
});

describe('the metrics ports on root', () => {
  it('are published on loopback only, never on PLATFORM_BIND or the mesh', () => {
    const ports = [
      ...published('docker-compose.exporters.yml', 'mongodb-exporter'),
      ...published('docker-compose.exporters.yml', 'postgres-exporter'),
      ...published('docker-compose.temporal.yml', 'temporal').filter((port) => port.endsWith(':9233')),
      ...published('docker-compose.registry.yml', 'registry-writer').filter((port) => port.endsWith(':5002')),
      ...published('docker-compose.registry.yml', 'registry-reader').filter((port) => port.endsWith(':5002')),
    ];
    expect(ports).toEqual(['127.0.0.1:9216:9216', '127.0.0.1:9187:9187', '127.0.0.1:9233:9233', '127.0.0.1:5005:5002', '127.0.0.1:5006:5002']);
  });

  it('are each checked by root-telemetry.sh to listen on loopback alone, with the collector\'s own', () => {
    const scraped = scrapes.flatMap((scrape) => scrape.static_configs.flatMap((statics) => statics.targets.map((target) => target.split(':')[1]!)));
    for (const port of [...scraped.filter((port) => port !== '2019'), '4317', '4318']) expect(metricPorts, port).toContain(port);
  });

  it('serve Temporal\'s and the registry\'s own metrics, which they keep off unless asked', () => {
    expect(yaml<Compose>('docker-compose.temporal.yml').services.temporal!.environment).toContain('PROMETHEUS_ENDPOINT=0.0.0.0:9233');
    for (const registry of ['registry-writer', 'registry-reader']) {
      expect(yaml<Compose>('docker-compose.registry.yml').services[registry]!.environment).toMatchObject({ REGISTRY_HTTP_DEBUG_ADDR: '0.0.0.0:5002', REGISTRY_HTTP_DEBUG_PROMETHEUS_ENABLED: 'true' });
    }
    expect(read('headscale/config/config.yaml')).toMatch(/^metrics_listen_addr: 0\.0\.0\.0:9090$/m);
    expect(published('docker-compose.headscale.yml', 'headscale')).toContain('${PLATFORM_BIND:-127.0.0.1}:9090:9090');
  });

  it('read Mongo and Postgres as accounts that may only watch, their passwords from root\'s compose env', () => {
    const exporters = yaml<Compose>('docker-compose.exporters.yml').services;
    expect(exporters['mongodb-exporter']!.environment).toMatchObject({ MONGODB_USER: 'koala-metrics' });
    expect((exporters['mongodb-exporter']!.environment as Record<string, string>).MONGODB_PASSWORD).toMatch(/^\$\{MONGO_EXPORTER_PASSWORD:\?/);
    expect(exporters['postgres-exporter']!.environment).toMatchObject({ DATA_SOURCE_USER: 'koala_metrics' });
    expect((exporters['postgres-exporter']!.environment as Record<string, string>).DATA_SOURCE_PASS).toMatch(/^\$\{POSTGRES_EXPORTER_PASSWORD:\?/);
    for (const exporter of Object.values(exporters)) expect(exporter.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
