import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { TRACE_ID_HEADER } from '../apps/backend/src/platform/services/MetricsService.js';
import { TURN_PROCEDURE_ID } from '../apps/backend/src/checks/lib/turn-check.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const ROOT = process.env.TELEMETRY_LIVE_ROOT ?? 'http://localhost:3001';
const ADMIN = process.env.MECHANICS_ADMIN ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = process.env.TELEMETRY_LIVE_KUBECONFIG ?? `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const SCENARIO = `telemetry-live-${Date.now().toString(36)}`;
const SAID = 'Hello from the scripted model, for the telemetry live test.';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stageCount = 0;
async function stage<T>(name: string, body: () => Promise<T>): Promise<T> {
  stageCount += 1;
  const started = Date.now();
  console.log(`[${stageCount}] ${name}`);
  try {
    const value = await body();
    console.log(`    ok (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    console.log(`    FAILED at "${name}": ${(err as Error).message}`);
    throw err;
  }
}

class Hopeless extends Error {}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      if (err instanceof Hopeless) throw err;
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 12 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5_000);
  }
}

const kubectl = async (...args: string[]) => (await run(KUBECTL, ['--kubeconfig', KUBECONFIG, ...args])).stdout.trim();
const serviceExists = async (name: string) => (await kubectl('get', 'service', name, '-n', 'monitoring', '--ignore-not-found', '-o', 'name')) !== '';

const client = (cookie?: string): AxiosInstance => axios.create({ baseURL: ROOT, proxy: false, maxRedirects: 0, headers: cookie ? { Cookie: cookie } : {}, validateStatus: () => true });
const sessionOf = (headers: Record<string, unknown>): string | undefined => ([] as string[]).concat((headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='));

const forwards: ChildProcess[] = [];
function portForward(service: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(KUBECTL, ['--kubeconfig', KUBECONFIG, '-n', 'monitoring', 'port-forward', '--address', '127.0.0.1', `svc/${service}`, `0:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    forwards.push(child);
    let errors = '';
    child.stderr?.on('data', (data: Buffer) => { errors += data.toString(); });
    child.stdout?.on('data', (data: Buffer) => {
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(data.toString());
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.on('close', (code) => reject(new Error(`port-forward to ${service} exited with ${code}: ${errors.trim()}`)));
  });
}

interface Named { name?: unknown; spanId?: unknown; parentSpanId?: unknown }

function spanNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { for (const entry of value) spanNames(entry, found); return found; }
  if (value && typeof value === 'object') {
    const named = value as Named;
    if (typeof named.name === 'string' && typeof named.spanId === 'string') found.push(named.name);
    for (const entry of Object.values(value)) spanNames(entry, found);
  }
  return found;
}

interface CheckRun { state: string; finished: number; error?: string; results: { scenarioId: string; runId: string; passed: boolean; outcome: string; reason?: string; error?: string; checks: { what: string; passed: boolean; detail: string }[] }[] }
interface KoalaView { state: string; reasons: string[]; numbers: Record<string, number | undefined>; services: string[]; lines: string[]; telemetry: { collector: boolean; tempo: boolean } }

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who invites this test\'s account');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const adminHttp = client(`session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 4 * 3600)}`);
  const email = `telemetry-live-${Date.now().toString(36)}@nowrinkles.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  let me: AxiosInstance | undefined;
  let myId: string | undefined;
  const runIds = new Set<string>();

  try {
    await stage('the collector and Tempo are on the system cluster, applied when the cluster worker started if they were missing', async () => {
      await until('otel-collector and tempo in the monitoring namespace', async () => ((await serviceExists('otel-collector')) && (await serviceExists('tempo')) ? true : undefined));
      const koala = await until('the backend seeing them too', async () => {
        const view = (await adminHttp.get('/api/infrastructure')).data as { koala: KoalaView };
        return view.koala.telemetry.collector && view.koala.telemetry.tempo ? view.koala : undefined;
      });
      console.log(`    Koala: ${koala.lines[0]}`);
    });

    await stage('a throwaway account signs up with an admin\'s invite', async () => {
      const invite = (await adminHttp.post('/api/admin/invites')).data as { code: string };
      const registered = await client().post('/api/auth/register', { email, password, inviteCode: invite.code });
      assert.equal(registered.status, 200, JSON.stringify(registered.data));
      const login = await client().post('/api/auth/login', { email, password });
      const cookie = sessionOf(login.headers);
      assert.ok(login.status === 200 && cookie, JSON.stringify(login.data));
      me = client(cookie);
      myId = (await me.get('/api/auth/me')).data.id as string;
    });

    const { traceId, runId } = await stage('a chat turn on a scripted model: one turn check, saved and run through the check runner, whose request carries the trace id back', async () => {
      const scenario = {
        id: SCENARIO,
        name: 'Telemetry live: a scripted hello',
        describe: 'One model turn on a script, so the request, the workflow start and the model call make one trace.',
        agent: 'koala',
        procedure: { id: TURN_PROCEDURE_ID },
        turn: true,
        input: { message: 'Say hello, nothing else.' },
        script: { rules: [{ when: {}, reply: { say: SAID } }] },
        expect: { chooses: { tool: null } },
      };
      const saved = await me!.put(`/api/evals/level2/scenarios/${SCENARIO}`, scenario);
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      const started = await me!.post('/api/evals/level2/runs', { only: [SCENARIO] });
      assert.equal(started.status, 202, JSON.stringify(started.data));
      const traceId = String(started.headers[TRACE_ID_HEADER] ?? '');
      assert.match(traceId, /^[0-9a-f]{32}$/, `the response carries no trace id in ${TRACE_ID_HEADER}`);
      const id = (started.data as { id: string }).id;
      const finished = await until('the check run to finish', async () => {
        const check = (await me!.get(`/api/evals/level2/runs/${id}`)).data as CheckRun;
        if (check.state === 'running') return undefined;
        return check;
      });
      assert.equal(finished.state, 'done', `the check run ended ${finished.state}: ${finished.error ?? ''}`);
      const result = finished.results.find((entry) => entry.scenarioId === SCENARIO);
      assert.ok(result?.runId, `the scenario never got a run: ${JSON.stringify(finished.results)}`);
      runIds.add(result.runId);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.outcome}${result.reason ? `: ${result.reason.slice(0, 160)}` : ''}; run ${result.runId}; trace ${traceId}`);
      assert.ok(result.passed, result.checks.filter((check) => !check.passed).map((check) => `${check.what}: ${check.detail}`).join('; '));
      return { traceId, runId: result.runId };
    });

    await stage('one trace in Tempo, found by its id, spans the request, the workflow start and the model call', async () => {
      const tempo = await portForward('tempo', 3200);
      const http = axios.create({ baseURL: tempo, proxy: false, validateStatus: () => true });
      const wanted = ['POST /api/evals/level2/runs', 'workflow.start CheckRunWorkflow', 'POST /api/engine/runs', 'workflow.start AgentRunWorkflow', 'model.call'];
      const names = await until(`the trace ${traceId} with ${wanted.join(', ')}`, async () => {
        const answer = await http.get(`/api/traces/${traceId}`);
        if (answer.status === 404) return undefined;
        assert.ok(answer.status === 200, `Tempo answered ${answer.status}: ${JSON.stringify(answer.data).slice(0, 200)}`);
        const names = spanNames(answer.data);
        return wanted.every((name) => names.includes(name)) ? names : undefined;
      });
      const activities = names.filter((name) => name.startsWith('activity ')).length;
      console.log(`    ${names.length} spans, ${activities} of them activities; the model call: ${names.filter((name) => name === 'model.call').length}`);
      assert.ok(activities > 0, 'no activity span joined the trace');
      assert.ok(!JSON.stringify(names).includes(SAID), 'the scripted reply leaked into a span name');
      const raw = JSON.stringify((await http.get(`/api/traces/${traceId}`)).data);
      assert.ok(!raw.includes(SAID) && !raw.includes('Say hello, nothing else'), 'what the person or the model said leaked into the trace');
      console.log(`    nothing said in the turn is in the trace; run ${runId}`);
    });

    await stage('the metrics are in Prometheus by their names, labelled with the process that reported them', async () => {
      const prometheus = await portForward('kube-prometheus-stack-prometheus', 9090);
      const http = axios.create({ baseURL: prometheus, proxy: false, validateStatus: () => true });
      const query = async (expr: string) => {
        const answer = await http.get('/api/v1/query', { params: { query: expr } });
        assert.ok(answer.status === 200 && answer.data?.status === 'success', `Prometheus answered ${answer.status}: ${JSON.stringify(answer.data).slice(0, 200)}`);
        return (answer.data.data.result as { metric: Record<string, string>; value: [number, string] }[]);
      };
      for (const [metric, service] of [
        ['koala_up', 'koala-backend'],
        ['koala_up', 'koala-worker-engine'],
        ['koala_http_request_seconds_count', 'koala-backend'],
        ['koala_workflows_started_total', 'koala-backend'],
        ['koala_activity_seconds_count', 'koala-worker-engine'],
        ['koala_model_call_seconds_count', 'koala-worker-engine'],
      ] as const) {
        const found = await until(`${metric} from ${service}`, async () => {
          const result = await query(`${metric}{service_name="${service}"}`);
          return result.length ? result : undefined;
        });
        console.log(`    ${metric}{service_name="${service}"}: ${found.length} series`);
      }
    });

    await stage('the Koala section on GET /api/infrastructure carries them', async () => {
      const koala = await until('the Koala section measuring requests and model calls', async () => {
        const view = (await me!.get('/api/infrastructure')).data as { koala: KoalaView };
        const { numbers, services } = view.koala;
        return numbers.requestsPerSecond !== undefined && numbers.modelCallsPerMinute !== undefined && services.includes('koala-backend') && services.includes('koala-worker-engine') ? view.koala : undefined;
      });
      assert.ok(koala.state === 'ok' || koala.state === 'warning', `Koala is ${koala.state}: ${koala.reasons.join('; ')}`);
      for (const line of koala.lines) console.log(`    ${line}`);
      assert.ok(koala.numbers.workflowsStartedHour! >= 1, 'no workflow started in the last hour');
    });

    await stage('the stack stays', async () => {
      assert.ok(await serviceExists('otel-collector'));
      assert.ok(await serviceExists('tempo'));
    });
  } finally {
    for (const child of forwards) child.kill();
    if (me && myId) {
      await me.delete(`/api/evals/level2/scenarios/${SCENARIO}`).catch(() => undefined);
      await forgetWhatRunsLeft(db, myId, runIds).catch(() => undefined);
      const removed = await me.delete('/api/account', { data: { confirm: email } });
      if (removed.status === 202) {
        for (let tries = 0; tries < 150 && await db.accounts.getUserById(myId); tries += 1) await sleep(2_000);
        console.log((await db.accounts.getUserById(myId)) ? `    ${email} is still being removed` : '    removed the test account');
      } else {
        console.log(`    could not remove ${email}: ${removed.status} ${JSON.stringify(removed.data)}`);
      }
    }
    await db.close();
  }
  console.log('\ntelemetry live — PASS');
}

main().catch((err) => {
  console.error(`\ntelemetry live — FAIL: ${(err as Error).message}`);
  process.exit(1);
});
