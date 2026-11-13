import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excerptEnv, scriptExcerpt, spawnScript } from '../coupling/shell-trace.js';

const ROOT_NODE = new URL('../../scripts/root-node/', import.meta.url).pathname;
const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const executable = (file: string, body: string): void => {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
};

const STUBS: Record<string, string> = {
  id: '#!/usr/bin/env bash\necho 0\n',
  sleep: '#!/usr/bin/env bash\nexit 0\n',
  npx: '#!/usr/bin/env bash\necho "npx $* with ROOT_KUBECONFIG=${ROOT_KUBECONFIG:-}" >> "$STUB_DIR/calls"\nexit "${STUB_STACK:-0}"\n',
  ss: '#!/usr/bin/env bash\nprintf "%s" "${STUB_SS:-}"\n',
  docker: [
    '#!/usr/bin/env bash',
    'echo "docker $*" >> "$STUB_DIR/calls"',
    'case "$1" in',
    '  ps) case "$*" in *service=mongodb*) echo nowrinkles-mongodb-1 ;; *service=postgresql*) echo nowrinkles-postgresql-1 ;; esac ;;',
    '  exec) cat >> "$STUB_DIR/$3.stdin"; case "$4" in mongosh) echo "${STUB_MONGO:-KOALA-MONITOR-READY}" ;; esac ;;',
    'esac',
    '',
  ].join('\n'),
  kubectl: [
    '#!/usr/bin/env bash',
    'echo "kubectl $*" >> "$STUB_DIR/calls"',
    'case "$*" in',
    '  *"get deployment otel-collector"*) asked=$(( $(cat "$STUB_DIR/asked" 2>/dev/null || echo 0) + 1 )); echo "$asked" > "$STUB_DIR/asked"; [ "$asked" -gt "${STUB_MADE_AFTER:-0}" ] ;;',
    '  *"rollout status"*) [ "${STUB_ROLLOUT:-0}" -eq 0 ] || { echo \'error: deployment "otel-collector" exceeded its progress deadline\'; exit 1; } ;;',
    '  *"get svc otel-collector"*) printf 10.43.0.9 ;;',
    'esac',
    '',
  ].join('\n'),
};

interface Root { repo: string; stubs: string; metrics: string; composeEnv: string; backendEnv: string }

function freshRoot(): Root {
  const repo = scratch('root-telemetry-repo-');
  const stubs = scratch('root-telemetry-stubs-');
  for (const [name, body] of Object.entries(STUBS)) executable(join(stubs, name), body);
  mkdirSync(join(repo, 'scripts/root-node'), { recursive: true });
  mkdirSync(join(repo, 'apps/backend'), { recursive: true });
  executable(join(repo, 'scripts/root-node/cdktf-bindings.sh'), '#!/usr/bin/env bash\necho "bindings $*" >> "$STUB_DIR/calls"\n');
  const composeEnv = join(repo, '.env');
  const backendEnv = join(repo, 'apps/backend/.env');
  writeFileSync(composeEnv, 'MONGO_ROOT_PASSWORD=rootpassword0123456789abcdef\nPLATFORM_BIND=127.0.0.1\n', { mode: 0o600 });
  writeFileSync(backendEnv, `NODE_ENV=production\nDATA_DIR=${join(repo, 'apps/backend/data')}\n`, { mode: 0o600 });
  return { repo, stubs, metrics: join(scratch('root-telemetry-metrics-'), 'metrics'), composeEnv, backendEnv };
}

const measure = (root: Root, env: Record<string, string> = {}) => spawnScript(join(ROOT_NODE, 'root-telemetry.sh'), [], {
  encoding: 'utf8',
  env: {
    ...process.env, PATH: `${root.stubs}:${process.env.PATH}`, STUB_DIR: root.stubs, REPO_DIR: root.repo,
    COMPOSE_ENV: root.composeEnv, BACKEND_ENV: root.backendEnv, KUBECTL: join(root.stubs, 'kubectl'), METRICS_DIR: root.metrics, ...env,
  },
});

const setting = (file: string, key: string): string | undefined => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1];
const calls = (root: Root): string => (existsSync(join(root.stubs, 'calls')) ? readFileSync(join(root.stubs, 'calls'), 'utf8') : '');

describe('root-telemetry.sh', () => {
  it('applies the cluster\'s monitoring, waits for its collector to be made and roll out, then starts the exporters and the host collector pointed at it', () => {
    const root = freshRoot();
    const ran = measure(root, { STUB_MADE_AFTER: '3' });
    expect(ran.stderr).not.toMatch(/❌/);
    expect(ran.status).toBe(0);
    expect(ran.stderr + ran.stdout).toMatch(/waiting for the cluster's collector \(deployment otel-collector in monitoring on k3d-provisioning-lunorica\) to be made/);
    const said = calls(root).split('\n');
    const at = (pattern: RegExp): number => said.findIndex((line) => pattern.test(line));
    expect(at(/^bindings /)).toBeGreaterThanOrEqual(0);
    expect(at(/^npx tsx scripts\/ensure-cluster-stack\.ts with ROOT_KUBECONFIG=\/var\/lib\/rancher\/k3s-provisioning-lunorica\/kubeconfig\.yaml$/)).toBeGreaterThan(at(/^bindings /));
    expect(at(/rollout status deployment\/otel-collector$/)).toBeGreaterThan(at(/^npx tsx/));
    expect(said.filter((line) => /get deployment otel-collector/.test(line))).toHaveLength(4);
    expect(at(/compose --env-file .* -f docker-compose\.exporters\.yml up -d$/)).toBeGreaterThan(at(/rollout status/));
    expect(at(/compose --env-file .* -f docker-compose\.otel\.yml up -d --force-recreate$/)).toBeGreaterThan(at(/docker-compose\.exporters\.yml/));
    expect(setting(root.composeEnv, 'OTEL_CLUSTER_COLLECTOR')).toBe('10.43.0.9:4317');
    expect(setting(root.backendEnv, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('http://127.0.0.1:4318');
    expect(statSync(root.metrics).isDirectory()).toBe(true);
  });

  it('makes a monitoring user in Mongo and a pg_monitor role in Postgres with passwords it keeps in root\'s compose env, mode 600, never printed', () => {
    const root = freshRoot();
    const ran = measure(root);
    expect(ran.status).toBe(0);
    const mongoPassword = setting(root.composeEnv, 'MONGO_EXPORTER_PASSWORD')!;
    const postgresPassword = setting(root.composeEnv, 'POSTGRES_EXPORTER_PASSWORD')!;
    expect(mongoPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(postgresPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(mongoPassword).not.toBe(postgresPassword);
    expect(statSync(root.composeEnv).mode & 0o777).toBe(0o600);
    for (const secret of [mongoPassword, postgresPassword, 'rootpassword0123456789abcdef']) {
      expect(ran.stdout).not.toContain(secret);
      expect(ran.stderr).not.toContain(secret);
      expect(calls(root)).not.toContain(secret);
    }
    const mongo = readFileSync(join(root.stubs, 'nowrinkles-mongodb-1.stdin'), 'utf8');
    expect(mongo).toContain("admin.auth('admin', 'rootpassword0123456789abcdef');");
    expect(mongo).toContain(`admin.createUser({ user: 'koala-metrics', pwd: '${mongoPassword}', roles });`);
    expect(mongo).toContain("const roles = [{ role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'local' }];");
    const postgres = readFileSync(join(root.stubs, 'nowrinkles-postgresql-1.stdin'), 'utf8');
    expect(postgres).toContain(`ALTER ROLE koala_metrics WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${postgresPassword}';`);
    expect(postgres).toContain('GRANT pg_monitor TO koala_metrics;');

    const again = measure(root);
    expect(again.status).toBe(0);
    expect(setting(root.composeEnv, 'MONGO_EXPORTER_PASSWORD')).toBe(mongoPassword);
    expect(setting(root.composeEnv, 'POSTGRES_EXPORTER_PASSWORD')).toBe(postgresPassword);
    expect(readFileSync(root.composeEnv, 'utf8').match(/^OTEL_CLUSTER_COLLECTOR=/gm)).toHaveLength(1);
  });

  it('refuses, starting no host collector, when the cluster\'s collector cannot roll out or its monitoring cannot be applied', () => {
    const stuck = freshRoot();
    const ran = measure(stuck, { STUB_ROLLOUT: '1' });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/the cluster's collector cannot roll out: error: deployment "otel-collector" exceeded its progress deadline/);
    expect(calls(stuck)).not.toMatch(/docker-compose\.otel\.yml/);
    expect(setting(stuck.composeEnv, 'OTEL_CLUSTER_COLLECTOR')).toBeUndefined();

    const unapplied = freshRoot();
    const failed = measure(unapplied, { STUB_STACK: '1' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/the system cluster's monitoring and telemetry could not be applied/);
    expect(calls(unapplied)).not.toMatch(/get deployment|docker /);
  });

  it('refuses when Mongo is not yet its replica set\'s primary, saying why', () => {
    const root = freshRoot();
    const ran = measure(root, { STUB_MONGO: 'KOALA-NOT-PRIMARY' });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/Mongo is not its replica set's primary yet/);
    expect(calls(root)).not.toMatch(/docker-compose\.(exporters|otel)\.yml/);
  });

  it('refuses when a metrics port answers beyond loopback', () => {
    const root = freshRoot();
    const ran = measure(root, { STUB_SS: 'LISTEN 0 4096 0.0.0.0:9216 0.0.0.0:*\n' });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/port 4317 is listening beyond 127\.0\.0\.1|port 9216 is listening beyond 127\.0\.0\.1/);
  });
});

describe('backup.sh recording its last success', () => {
  it('writes an OTLP gauge the host collector reads again on every poll, replacing the last one whole', () => {
    const dir = join(scratch('backup-metric-'), 'metrics');
    const run = (at: string) => spawnSync('bash', ['-c', scriptExcerpt(join(ROOT_NODE, 'backup.sh'), ['record_success'], `set -eu\nrecord_success ${dir} ${at}`)], { encoding: 'utf8', env: { ...process.env, ...excerptEnv() } });
    expect(run('1793900000').status).toBe(0);
    expect(run('1793924421').status).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8')) as { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }; scopeMetrics: Array<{ metrics: Array<{ name: string; gauge: { dataPoints: Array<{ asInt: string; timeUnixNano: string }> } }> }> }> };
    const metric = written.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(metric.name).toBe('koala_root_backup_last_success_seconds');
    expect(metric.gauge.dataPoints).toEqual([{ asInt: '1793924421', timeUnixNano: '1793924421000000000' }]);
    expect(written.resourceMetrics[0]!.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'koala-backup' } }]);
    expect(statSync(join(dir, 'backup.json')).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dir, '.backup.json.next'))).toBe(false);
  });
});
