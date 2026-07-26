#!/usr/bin/env -S npx tsx
/**
 * palworld-synth.ts — asserts on the Terraform the Palworld AppStack actually generates.
 *
 * This is the highest-value check for a game server and it needs no cluster, no credentials and
 * no network: `cdktf synth` renders the stack to JSON and we assert on the result. Everything it
 * covers is something that would otherwise only surface as a broken or unreachable server:
 *
 *  - hostPort/UDP present (the whole reason players can connect at all)
 *  - strategy: Recreate (without it, every settings save deadlocks the rollout permanently)
 *  - the shutdown grace period (without it, world saves get truncated)
 *  - no Ingress (a UDP server behind an HTTP Ingress is meaningless)
 *  - the probe module (http_2xx against a token-gated REST API reports down forever)
 *  - and the direct, mechanical proof that no password literal reaches disk
 *
 * Run: npx tsx tests/palworld-synth.ts
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PALWORLD_SCHEMA } from '../apps/backend/src/lib/palworld-settings.js';
import { resolveAppSettings } from '../apps/backend/src/lib/app-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CDKTF_DIR = path.join(ROOT, 'packages/cdktf-infra');
const DEPLOYMENT = 'synthtest';

// If this string appears anywhere in the synthesized JSON, secrets are reaching disk.
const SENTINEL = 'SENTINEL-PASSWORD-MUST-NOT-APPEAR';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  const settings = resolveAppSettings(PALWORLD_SCHEMA, { DIFFICULTY: 'Hard', EXP_RATE: '2.0' });

  console.log(`Synthesizing Palworld AppStack (${Object.keys(settings).length} settings)…`);
  execFileSync('npx', ['cdktf', 'synth'], {
    cwd: CDKTF_DIR,
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}`,
      STACK_TYPE: 'app',
      APP_TYPE: 'palworld',
      DEPLOYMENT_STRATEGY: 'native',
      DEPLOYMENT_NAME: DEPLOYMENT,
      DEPLOYMENT_ID: 'synth',
      CLUSTER_NAME: 'synth-cluster',
      KUBECONFIG: '/tmp/fake-kubeconfig',
      STORAGE_DATA: '30Gi',
      APP_SETTINGS_JSON: JSON.stringify({ ...settings, ADMIN_PASSWORD: SENTINEL }),
    },
  });

  const stackDir = path.join(CDKTF_DIR, 'cdktf.out/stacks', `app-synth-cluster-synth`);
  const raw = fs.readFileSync(path.join(stackDir, 'cdk.tf.json'), 'utf-8');
  const tf = JSON.parse(raw);

  const deployments = tf.resource?.kubernetes_deployment ?? {};
  const dep: any = Object.values(deployments)[0];
  // CDKTF emits these blocks as plain objects here, but Terraform's schema allows list form —
  // unwrap defensively so a provider-version change doesn't silently turn every assertion green.
  const one = (v: any) => (Array.isArray(v) ? v[0] : v);
  const spec = one(dep?.spec);
  const podSpec = one(one(spec?.template)?.spec);
  const container = one(podSpec?.container);

  console.log('\nAssertions:');

  // ── Reachability ────────────────────────────────────────────────────────
  const ports: any[] = container?.port ?? [];
  const game = ports.find((p) => p.container_port === 8211);
  const query = ports.find((p) => p.container_port === 27015);
  check('game port 8211 is UDP with a hostPort', game?.protocol === 'UDP' && game?.host_port === 8211,
    JSON.stringify(game));
  check('query port 27015 is UDP with a hostPort', query?.protocol === 'UDP' && query?.host_port === 27015,
    JSON.stringify(query));
  // Control ports must NOT be published on the node.
  const rest = ports.find((p) => p.container_port === 8212);
  check('REST port 8212 is TCP and NOT on the host', rest?.protocol === 'TCP' && rest?.host_port === undefined,
    JSON.stringify(rest));

  // ── The three settings that silently break the app if wrong ─────────────
  check('strategy is Recreate', one(spec?.strategy)?.type === 'Recreate',
    `got ${JSON.stringify(spec?.strategy)}`);
  check('termination grace period is 60s', podSpec?.termination_grace_period_seconds === 60,
    `got ${podSpec?.termination_grace_period_seconds}`);
  check('runs as the PUID/PGID the image expects',
    one(podSpec?.security_context)?.run_as_user === '1000' && one(podSpec?.security_context)?.fs_group === '1000');

  // ── Settings actually reach the pod ─────────────────────────────────────
  const env: any[] = container?.env ?? [];
  const byName = new Map(env.map((e) => [e.name, e]));
  check('all non-secret schema settings are present as env vars',
    Object.keys(settings).every((k) => byName.has(k)),
    `${env.length} env vars for ${Object.keys(settings).length} settings`);
  check('user overrides win over defaults',
    byName.get('DIFFICULTY')?.value === 'Hard' && byName.get('EXP_RATE')?.value === '2.0');
  check('env list is sorted (stable plan diffs)', (() => {
    const names = env.filter((e) => e.value !== undefined).map((e) => e.name);
    return names.join() === [...names].sort((a, b) => a.localeCompare(b)).join();
  })());

  // ── Secrets never reach disk ────────────────────────────────────────────
  check('passwords come from a secretKeyRef, not a literal',
    ['ADMIN_PASSWORD', 'SERVER_PASSWORD', 'RCON_PASSWORD'].every(
      (n) => one(one(byName.get(n)?.value_from)?.secret_key_ref)?.name === 'palworld-secrets',
    ));
  // The mechanical proof: even though the sentinel was passed in via APP_SETTINGS_JSON, the
  // construct must strip it in favour of the Secret reference.
  check('no password literal anywhere in the synthesized Terraform', !raw.includes(SENTINEL));

  // ── HTTP machinery must be absent ───────────────────────────────────────
  check('no Ingress is created', tf.resource?.kubernetes_ingress_v1 === undefined,
    Object.keys(tf.resource?.kubernetes_ingress_v1 ?? {}).join());

  const services = tf.resource?.kubernetes_service ?? {};
  const svc: any = Object.values(services)[0];
  const svcSpec = one(svc?.spec);
  const svcPorts: any[] = svcSpec?.port ?? [];
  check('Service is ClusterIP and carries only TCP control ports',
    svcSpec?.type === 'ClusterIP' && svcPorts.length > 0 &&
      svcPorts.every((p) => p.port === 8212 || p.port === 25575),
    JSON.stringify(svcPorts.map((p) => p.port)));

  // ── Health probing ──────────────────────────────────────────────────────
  const manifests = tf.resource?.kubernetes_manifest ?? {};
  const probe: any = Object.values(manifests).find((m: any) => m?.manifest?.kind === 'Probe');
  check('probe uses tcp_connect against the REST port',
    probe?.manifest?.spec?.module === 'tcp_connect' &&
      String(probe?.manifest?.spec?.targets?.staticConfig?.static?.[0] ?? '').endsWith(':8212'),
    JSON.stringify(probe?.manifest?.spec?.module));

  console.log(
    failures === 0
      ? '\nPASS — Palworld stack synthesizes correctly\n'
      : `\nFAIL — ${failures} assertion(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
