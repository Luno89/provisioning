/**
 * Real, end-to-end proof of the distributed-systems plan's Phase 2 ("generic SSH-based k3s
 * bootstrap for remote hosts"): boots a disposable QEMU VM (tests/lib/disposable-vm.ts),
 * registers it as a `provider: 'remote'` cluster through the real running backend/Temporal
 * stack — exactly the path a real user hits — waits for it to become healthy, verifies kubectl
 * connectivity against the resulting (mesh-address-rewritten) kubeconfig, deploys a real
 * lightweight app onto it, then tears everything down (app, cluster, VM, throwaway user/invite).
 *
 * Assumes the dev stack is already running (backend on :3001, Temporal, Mongo, and the
 * in-cluster/host Temporal workers) — same precondition as `npm run test:e2e`. Not part of the
 * default `npm test` chain (boots a real VM, several minutes) — run explicitly via
 * `npm run test:remote-integration`, same tier as `npm run test:infra:integration`.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createDisposableVm } from './lib/disposable-vm.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

const execFileAsync = promisify(execFile);
const BASE = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/$/, '');

// No self-serve "delete my account" or "delete this invite" route exists — direct Mongo cleanup,
// matching how every throwaway test user/invite created manually during this session's live
// verification was cleaned up. Best-effort: a failure here leaves a harmless throwaway row behind,
// not a reason to fail the whole test.
async function cleanupTestUser(email: string, inviteCode: string): Promise<void> {
  const script = `db.users.deleteOne({email: "${email}"}); db.invites.deleteOne({code: "${inviteCode}"});`;
  await execFileAsync('docker', [
    'exec', 'provisioning-mongodb-1', 'mongosh', '--quiet',
    '-u', 'admin', '-p', 'admin', '--authenticationDatabase', 'admin', 'provisioning',
    '--eval', script,
  ]).catch((e) => console.warn(`  ⚠ test user/invite cleanup failed (harmless): ${e.message}`));
}

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`Expected a Set-Cookie header from ${res.url}, got none`);
  const match = raw.match(/session=[^;]+/);
  if (!match) throw new Error(`Set-Cookie header had no session cookie: ${raw}`);
  return match[0];
}

async function loginAsExistingAdmin(): Promise<string> {
  // Zero-setup dev OAuth mock path (see index.ts's /api/auth/google — falls back to a fixed
  // mock-google-user@example.com identity when GOOGLE_CLIENT_ID isn't configured), used here
  // purely to reach whichever account bootstrap already made admin, so we can mint a real invite
  // for the throwaway test user below without needing that account's real credentials.
  // /api/auth/google itself only redirects (302) to /api/auth/google/callback — the session
  // cookie is set on THAT response, one hop later (confirmed live: the first response has no
  // Set-Cookie header at all).
  const initial = await fetch(`${BASE}/api/auth/google`, { redirect: 'manual' });
  const callbackUrl = initial.headers.get('location');
  if (!callbackUrl) throw new Error(`/api/auth/google did not redirect (expected a Location header): HTTP ${initial.status}`);
  const res = await fetch(callbackUrl, { redirect: 'manual' });
  const cookie = extractCookie(res);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  if (!me.isAdmin) {
    throw new Error('The mock-OAuth admin account is not actually admin — cannot mint an invite for the test user. Was migrateLegacyOwnership run?');
  }
  return cookie;
}

async function mintInvite(adminCookie: string): Promise<string> {
  const res = await fetch(`${BASE}/api/admin/invites`, { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`Failed to mint invite: HTTP ${res.status}`);
  const body = await res.json();
  return body.code;
}

async function registerAndLogin(email: string, password: string, inviteCode: string): Promise<string> {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, inviteCode }),
  });
  if (!reg.ok) throw new Error(`Registration failed: HTTP ${reg.status} ${await reg.text()}`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Login failed: HTTP ${login.status} ${await login.text()}`);
  return extractCookie(login);
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
  console.log('🚀 [Remote Host Integration Test] Starting...');
  let vm: Awaited<ReturnType<typeof createDisposableVm>> | undefined;
  let userCookie: string | undefined;
  let clusterId: string | undefined;
  let deploymentId: string | undefined;
  let testEmail: string | undefined;
  let inviteCode: string | undefined;
  let passed = false;
  let failureError: Error | undefined;

  try {
    console.log('🖥  Booting disposable VM...');
    vm = await createDisposableVm('remote-host-it');

    console.log('🔑 Setting up a throwaway test user via a real invite...');
    const adminCookie = await loginAsExistingAdmin();
    inviteCode = await mintInvite(adminCookie);
    testEmail = `remote-host-it-${Date.now()}@example.com`;
    userCookie = await registerAndLogin(testEmail, 'Password123!', inviteCode);

    const clusterName = `remote-it-${Date.now()}`;
    console.log(`🔨 Provisioning provider:'remote' cluster "${clusterName}" against the disposable VM...`);
    const provisionRes = await fetch(`${BASE}/api/clusters`, {
      method: 'POST', headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: clusterName, provider: 'remote',
        remoteHost: vm.host, remoteUsername: vm.username, remoteSshPrivateKey: vm.privateKey, remoteSshPort: vm.port,
        remoteK3sApiPort: vm.k3sApiPort,
      }),
    });
    if (!provisionRes.ok) throw new Error(`Provision request failed: HTTP ${provisionRes.status} ${await provisionRes.text()}`);
    const provisionBody = await provisionRes.json();
    clusterId = provisionBody.id;
    console.log(`⏳ Provisioning started (cluster id ${clusterId}). Polling for healthy...`);

    const cluster = await pollUntil('cluster to become healthy', 15 * 60 * 1000, async () => {
      const res = await fetch(`${BASE}/api/clusters`, { headers: { Cookie: userCookie! } });
      const clusters = await res.json();
      const current = clusters.find((c: any) => c.id === clusterId);
      console.log(`  ⏱  status: ${current?.status ?? 'missing'}${current?.progress?.step ? ` (${current.progress.step})` : ''}`);
      if (current?.status === 'healthy') return current;
      if (current?.status === 'failed') throw new Error('Cluster provisioning reported status "failed"');
      return undefined;
    });
    console.log('✅ Cluster is healthy');

    const kubeconfigPath = `/tmp/kubeconfig-${clusterName}`;
    console.log(`🔍 Verifying kubectl connectivity via ${kubeconfigPath} (mesh-address-rewritten kubeconfig)...`);
    const infra = new InfrastructureService();
    const nodesJson = await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
    const nodes = JSON.parse(nodesJson).items ?? [];
    const hasReady = nodes.some((n: any) => n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True'));
    if (!hasReady) throw new Error(`kubectl get nodes against ${kubeconfigPath} reported no Ready node`);
    console.log(`✅ Real k3s node confirmed Ready via kubectl (proves the mesh-IP kubeconfig rewrite actually works, not just that provisioning succeeded)`);

    // strategy: 'native' (raw K8s manifests, constructs/audiobookshelf-native.ts), not 'helm' —
    // confirmed live that the helm-strategy path (constructs/audiobookshelf.ts, the
    // charts.christianhuth.de chart) has no default PersistentVolumeClaim sizes at all
    // ("spec.resources[storage]: Required value" from Terraform), and DeployAppActivity.ts calls
    // StorageAdapter.getStorageEnv(appType, strategy, {}) with a hardcoded empty override object
    // — storage sizing has no route from the API request into that activity at all today. That's
    // a real, pre-existing gap affecting every helm-strategy app on every provider, not something
    // specific to 'remote' clusters or in scope for this test to fix. The native strategy has
    // real hardcoded defaults (2Gi/1Gi/5Gi), so it exercises the same "deploy a real app onto a
    // remote cluster" claim without tripping over that unrelated gap.
    console.log('📦 Deploying a real app (audiobookshelf) onto the remote cluster...');
    const deployRes = await fetch(`${BASE}/api/deployments`, {
      method: 'POST', headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusterId, name: `remote-it-app-${Date.now()}`, appType: 'audiobookshelf', strategy: 'native' }),
    });
    if (!deployRes.ok) throw new Error(`Deploy request failed: HTTP ${deployRes.status} ${await deployRes.text()}`);
    const deployBody = await deployRes.json();
    deploymentId = deployBody.id;

    // Confirmed live: 10 min was too tight — the deploy was genuinely still progressing (app
    // namespace created, pod scheduled, a normal transient "PVC not found" scheduling message
    // that resolves itself), just slower than that budget allowed, most likely a real image pull
    // for docker.io/ghcr.io/advplyr/audiobookshelf on a fresh VM with no image cache. 20 min
    // matches the generosity already given to cluster provisioning itself (15 min) plus margin.
    await pollUntil('deployment to become running', 20 * 60 * 1000, async () => {
      const res = await fetch(`${BASE}/api/deployments`, { headers: { Cookie: userCookie! } });
      const deployments = await res.json();
      const current = deployments.find((d: any) => d.id === deploymentId);
      console.log(`  ⏱  deployment status: ${current?.status ?? 'missing'}`);
      if (current?.status === 'running') return current;
      if (current?.status === 'failed') throw new Error('App deployment reported status "failed"');
      return undefined;
    });
    console.log('✅ App deployed and running on the remote cluster — proves the rest of the platform genuinely doesn\'t care that the cluster is remote');

    passed = true;
  } catch (err: any) {
    failureError = err;
  } finally {
    if (failureError) {
      console.error('🔴 Test failed with error:', failureError.stack || failureError.message);
    }
    console.log('🧹 Cleaning up...');
    if (userCookie && deploymentId) {
      try {
        await fetch(`${BASE}/api/deployments/${deploymentId}`, { method: 'DELETE', headers: { Cookie: userCookie } });
        await pollUntil('deployment to be destroyed', 5 * 60 * 1000, async () => {
          const res = await fetch(`${BASE}/api/deployments`, { headers: { Cookie: userCookie! } });
          const deployments = await res.json();
          return deployments.some((d: any) => d.id === deploymentId) ? undefined : true;
        }).catch((e) => console.warn(`  ⚠ deployment cleanup: ${e.message}`));
      } catch (e: any) {
        console.warn(`  ⚠ deployment cleanup failed: ${e.message}`);
      }
    }
    if (userCookie && clusterId) {
      try {
        await fetch(`${BASE}/api/clusters/${clusterId}`, { method: 'DELETE', headers: { Cookie: userCookie } });
        await pollUntil('cluster to be destroyed', 5 * 60 * 1000, async () => {
          const res = await fetch(`${BASE}/api/clusters`, { headers: { Cookie: userCookie! } });
          const clusters = await res.json();
          return clusters.some((c: any) => c.id === clusterId) ? undefined : true;
        }).catch((e) => console.warn(`  ⚠ cluster cleanup: ${e.message}`));
      } catch (e: any) {
        console.warn(`  ⚠ cluster cleanup failed: ${e.message}`);
      }
    }
    if (vm) {
      await vm.destroy().catch((e) => console.warn(`  ⚠ VM cleanup failed: ${e.message}`));
    }
    if (testEmail && inviteCode) {
      await cleanupTestUser(testEmail, inviteCode);
    }

    if (passed) {
      console.log('🟢 [Remote Host Integration Test] PASS');
      process.exit(0);
    } else {
      console.log('🔴 [Remote Host Integration Test] FAIL');
      process.exit(1);
    }
  }
}

run();
