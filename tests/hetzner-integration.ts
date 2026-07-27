/**
 * Real, end-to-end proof of the distributed-systems plan's Phase 3 ("provision the VM ourselves"):
 * creates an actual Hetzner Cloud server through the real running backend/Temporal stack — the
 * exact path a user hits from the cluster wizard — waits for it to become healthy, verifies
 * kubectl connectivity, deploys a real app onto it, then destroys everything and independently
 * confirms via the Hetzner API that the server is gone.
 *
 * THIS SPENDS REAL MONEY. Hetzner bills hourly, so a full pass costs roughly EUR 0.01 on the
 * default cx33 — but an orphaned server bills until someone deletes it. The cleanup block runs on
 * failure and on SIGINT, and the final step asks Hetzner directly rather than trusting our own
 * "destroyed" status. If that check ever fails it prints the server id and exits non-zero, because
 * a silent orphan is the only genuinely expensive failure mode here.
 *
 * Assumes the dev stack is already running (backend on :3001, Temporal, Mongo, both workers) and
 * that the admin account has a Hetzner token stored under Cloud Accounts. Not part of any default
 * chain — run explicitly via `npm run test:hetzner-integration`.
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { decryptValue } from '../apps/backend/src/lib/crypto.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

// Explicit path, not `dotenv/config`: this test runs from the repo root but the only .env lives in
// apps/backend, so the bare import silently leaves JWT_SECRET undefined and the credential decrypt
// dies with an opaque scrypt type error.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../apps/backend/.env') });

const BASE = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/$/, '');

// cx33 (4 vCPU / 8GB) is the cheapest plan that fits the stack: tests/lib/memory-budget.ts puts a
// full cluster+observability deploy at ~4.9GB, so the 4GB cx23 would fail on scheduling rather
// than on anything this test is trying to prove. nbg1 because Hetzner's US locations cost 3.4x
// more for the same plan and bundle 1TB of traffic instead of 20TB.
const SERVER_TYPE = process.env.HETZNER_TEST_SERVER_TYPE || 'cx33';
const LOCATION = process.env.HETZNER_TEST_LOCATION || 'nbg1';

const hetznerApi = async (token: string, path: string): Promise<any> => {
  const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Hetzner API ${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
};

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`Expected a Set-Cookie header from ${res.url}, got none`);
  const match = raw.match(/session=[^;]+/);
  if (!match) throw new Error(`Set-Cookie header had no session cookie: ${raw}`);
  return match[0];
}

/**
 * Logs in as the admin via the zero-setup dev OAuth mock. Unlike the remote-host test this does
 * NOT create a throwaway user: Hetzner credentials are stored per-user, so the test has to run as
 * the account that actually owns the token. /api/auth/google only redirects — the cookie is set
 * one hop later on the callback.
 */
async function loginAsCredentialedAdmin(): Promise<string> {
  const initial = await fetch(`${BASE}/api/auth/google`, { redirect: 'manual' });
  const callbackUrl = initial.headers.get('location');
  if (!callbackUrl) throw new Error(`/api/auth/google did not redirect: HTTP ${initial.status}`);
  const cookie = extractCookie(await fetch(callbackUrl, { redirect: 'manual' }));
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  if (!me?.id) throw new Error('Mock-OAuth login did not yield a user');
  return cookie;
}

/** The same decrypt path VpsCatalogService uses — needed to verify teardown against Hetzner. */
async function resolveHetznerToken(): Promise<string> {
  const db = await createDatabase();
  await (db as any).init();
  const users: any[] = await (db as any).getUsers();
  const owner = users.find((u) => u?.credentials?.hetzner?.token);
  if (!owner) {
    throw new Error('No user has a Hetzner token stored — add one under Cloud Accounts first.');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set — apps/backend/.env did not load, so the stored credential cannot be decrypted.');
  }
  return decryptValue(owner.credentials.hetzner.token, process.env.JWT_SECRET);
}

async function pollUntil<T>(label: string, timeoutMs: number, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function run() {
  console.log('🚀 [Hetzner Integration Test] Starting — THIS CREATES A REAL, BILLABLE SERVER');
  console.log(`   plan=${SERVER_TYPE} location=${LOCATION}`);

  const token = await resolveHetznerToken();
  const clusterName = `hetzner-it-${Date.now()}`;

  let cookie: string | undefined;
  let clusterId: string | undefined;
  let deploymentId: string | undefined;
  let passed = false;
  let failureError: Error | undefined;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log('🧹 Cleaning up...');

    if (cookie && deploymentId) {
      await fetch(`${BASE}/api/deployments/${deploymentId}`, { method: 'DELETE', headers: { Cookie: cookie } })
        .then(() => pollUntil('deployment to be destroyed', 5 * 60 * 1000, async () => {
          const d = await fetch(`${BASE}/api/deployments`, { headers: { Cookie: cookie! } }).then((r) => r.json());
          return d.some((x: any) => x.id === deploymentId) ? undefined : true;
        }))
        .catch((e: any) => console.warn(`  ⚠ deployment cleanup: ${e.message}`));
    }

    if (cookie && clusterId) {
      await fetch(`${BASE}/api/clusters/${clusterId}`, { method: 'DELETE', headers: { Cookie: cookie } })
        .then(() => pollUntil('cluster to be destroyed', 10 * 60 * 1000, async () => {
          const c = await fetch(`${BASE}/api/clusters`, { headers: { Cookie: cookie! } }).then((r) => r.json());
          const still = c.find((x: any) => x.id === clusterId);
          if (still) console.log(`  ⏱  cluster status: ${still.status}`);
          return still && still.status !== 'destroyed' ? undefined : true;
        }))
        .catch((e: any) => console.warn(`  ⚠ cluster cleanup: ${e.message}`));
    }

    // The step that actually matters. Our own "destroyed" status is a claim about our database;
    // this asks the party doing the billing. Anything still standing is reported loudly, with the
    // id needed to kill it by hand.
    try {
      const { servers } = await hetznerApi(token, '/servers');
      const orphans = (servers ?? []).filter((s: any) => String(s.name).includes(clusterName));
      if (orphans.length) {
        console.error(`🔴 ORPHANED HETZNER SERVER(S) STILL BILLING — delete these by hand:`);
        for (const s of orphans) console.error(`     id=${s.id} name=${s.name} type=${s.server_type?.name} status=${s.status}`);
        passed = false;
      } else {
        console.log(`✅ Hetzner confirms no server matching "${clusterName}" remains — nothing is still billing`);
      }
    } catch (e: any) {
      console.error(`🔴 Could not verify teardown against the Hetzner API: ${e.message}`);
      console.error(`   Check https://console.hetzner.cloud manually for a server named like "${clusterName}".`);
      passed = false;
    }
  };

  // A Ctrl-C midway would otherwise leave a server running indefinitely.
  const onSignal = () => { void cleanup().then(() => process.exit(130)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    console.log('🔑 Logging in as the Hetzner-credentialed admin...');
    cookie = await loginAsCredentialedAdmin();

    console.log(`🔨 Provisioning provider:'hetzner' cluster "${clusterName}"...`);
    const res = await fetch(`${BASE}/api/clusters`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: clusterName, provider: 'hetzner',
        hetznerServerType: SERVER_TYPE, hetznerLocation: LOCATION,
      }),
    });
    if (!res.ok) throw new Error(`Provision request failed: HTTP ${res.status} ${await res.text()}`);
    clusterId = (await res.json()).id;
    console.log(`⏳ Provisioning started (cluster id ${clusterId}). Polling...`);

    // 25 min: VM create and boot are fast (~1 min), but k3s plus the full observability stack is
    // a real install over the network on a machine with no image cache.
    await pollUntil('cluster to become healthy', 25 * 60 * 1000, async () => {
      const clusters = await fetch(`${BASE}/api/clusters`, { headers: { Cookie: cookie! } }).then((r) => r.json());
      const current = clusters.find((c: any) => c.id === clusterId);
      console.log(`  ⏱  status: ${current?.status ?? 'missing'}${current?.progress?.step ? ` (${current.progress.step})` : ''}`);
      if (current?.status === 'healthy') return current;
      if (current?.status === 'failed') throw new Error('Cluster provisioning reported status "failed"');
      return undefined;
    });
    console.log('✅ Cluster is healthy');

    // Confirm against Hetzner that we got the machine we asked for — a wrong server_type would
    // still boot and still pass every check below, while quietly costing a different amount.
    const { servers } = await hetznerApi(token, '/servers');
    const server = (servers ?? []).find((s: any) => String(s.name).includes(clusterName));
    if (!server) throw new Error(`Cluster is healthy but no Hetzner server matches "${clusterName}"`);
    console.log(`✅ Hetzner server id=${server.id} type=${server.server_type?.name} location=${server.datacenter?.location?.name} ip=${server.public_net?.ipv4?.ip}`);
    if (server.server_type?.name !== SERVER_TYPE) {
      throw new Error(`Asked for ${SERVER_TYPE} but Hetzner created ${server.server_type?.name}`);
    }

    const kubeconfigPath = `/tmp/kubeconfig-${clusterName}`;
    console.log(`🔍 Verifying kubectl connectivity via ${kubeconfigPath}...`);
    const infra = new InfrastructureService();
    const nodes = JSON.parse(await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath)).items ?? [];
    if (!nodes.some((n: any) => n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True'))) {
      throw new Error(`kubectl get nodes against ${kubeconfigPath} reported no Ready node`);
    }
    console.log('✅ Real k3s node confirmed Ready on the Hetzner VM');

    // strategy:'native' for the same reason as the remote-host test — the helm path for this app
    // has no default PVC sizes and storage sizing has no route from the API into the activity.
    console.log('📦 Deploying a real app (audiobookshelf)...');
    const deployRes = await fetch(`${BASE}/api/deployments`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusterId, name: `hetzner-it-app-${Date.now()}`, appType: 'audiobookshelf', strategy: 'native' }),
    });
    if (!deployRes.ok) throw new Error(`Deploy request failed: HTTP ${deployRes.status} ${await deployRes.text()}`);
    deploymentId = (await deployRes.json()).id;

    await pollUntil('deployment to become running', 20 * 60 * 1000, async () => {
      const d = await fetch(`${BASE}/api/deployments`, { headers: { Cookie: cookie! } }).then((r) => r.json());
      const current = d.find((x: any) => x.id === deploymentId);
      console.log(`  ⏱  deployment status: ${current?.status ?? 'missing'}`);
      if (current?.status === 'running') return current;
      if (current?.status === 'failed') throw new Error('App deployment reported status "failed"');
      return undefined;
    });
    console.log('✅ App running on a cluster we provisioned ourselves — Phase 3 proven end to end');

    passed = true;
  } catch (err: any) {
    failureError = err;
  } finally {
    if (failureError) console.error('🔴 Test failed:', failureError.stack || failureError.message);
    await cleanup();
    console.log(passed ? '🟢 [Hetzner Integration Test] PASS' : '🔴 [Hetzner Integration Test] FAIL');
    process.exit(passed ? 0 : 1);
  }
}

run();
