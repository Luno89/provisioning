/**
 * vllm-gpu-deploy — Level 3-style isolated test verifying a GPU-backed vLLM app deploys onto
 * the system (management) cluster and actually gets real GPU device access.
 *
 * This exercises the exact chain of bugs fixed this session:
 *   1. TemporalBridge.deployApp() resolving the target cluster via ClusterService.getById()
 *      (which knows about the synthetic system-cluster entry) instead of a raw db.getClusters()
 *      lookup that silently misses it.
 *   2. clusterGpuEnabled being threaded through to DeployAppActivity so it skips the k3d
 *      `image import` step (which fails for the system cluster — it isn't a real k3d cluster).
 *   3. The pod that results from all that actually getting real GPU device passthrough on the
 *      native k3s management cluster (the whole point of the session's earlier work).
 *
 * Does NOT wait for the vLLM server itself to finish loading model weights (that depends on
 * Hugging Face gated-repo access, outside this test's control) — it passes once the container
 * is running with GPU devices visible, which is what "provisioned onto the system cluster" and
 * "GPU passthrough works" actually mean here.
 *
 * Usage: npx tsx tests/vllm-gpu-deploy.ts [deployment-name]
 * Requires: the native k3s management cluster to be up (npm run dev / setup already run),
 * Temporal + Mongo running, and the cluster worker (worker-cluster.ts) listening so the
 * activity actually executes.
 */
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ClusterService } from '../apps/backend/src/services/ClusterService.js';
import { TemporalBridge } from '../apps/backend/src/services/TemporalBridge.js';

const DEPLOYMENT_NAME = process.argv[2] || 'Vllm-Production';
const SYSTEM_CLUSTER_ID = 'provisioning-lunorica';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 6 * 60 * 1000; // 6 min — image pull + pod scheduling, not model load

function log(msg: string) {
  console.log(`[vllm-gpu-deploy] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  log(`Testing GPU deploy for "${DEPLOYMENT_NAME}" onto the system cluster (${SYSTEM_CLUSTER_ID})...`);

  const db = createDatabase();
  await db.init();

  const dep = (await db.getDeployments()).find((d) => d.name === DEPLOYMENT_NAME);
  if (!dep) {
    console.error(`🔴 FAIL: no deployment named "${DEPLOYMENT_NAME}" found in the DB. Create it via the UI first (Deploy App → vLLM, targeting the "System" cluster card), then re-run this test.`);
    process.exit(1);
  }
  if (dep.clusterId !== SYSTEM_CLUSTER_ID) {
    console.error(`🔴 FAIL: deployment "${DEPLOYMENT_NAME}" targets clusterId="${dep.clusterId}", not the system cluster ("${SYSTEM_CLUSTER_ID}"). This test is specifically for the system-cluster path.`);
    process.exit(1);
  }
  log(`Found existing deployment: appType=${dep.appType}, model=${dep.vllmModel}, gpuCount=${dep.vllmGpuCount}`);

  const infra = new InfrastructureService();
  const clusterService = new ClusterService(db, infra);

  // Sanity check up front: does the synthetic system-cluster entry actually resolve, and is it
  // healthy? If this fails, nothing downstream will work either — fail fast with a clear reason.
  const systemCluster = await clusterService.getById(SYSTEM_CLUSTER_ID);
  if (!systemCluster || systemCluster.status !== 'healthy') {
    console.error(`🔴 FAIL: system cluster entry is not healthy (status=${systemCluster?.status}). Is native k3s running? Check: systemctl is-active k3s-provisioning-lunorica`);
    process.exit(1);
  }
  log(`System cluster resolved OK (gpuEnabled=${systemCluster.gpuEnabled}).`);

  const temporalBridge = new TemporalBridge(db, undefined, process.env.JWT_SECRET, clusterService);
  await temporalBridge.start();
  log('Connected to Temporal.');

  log(`Triggering deploy (reuses existing deployment config — model/GPU/HF token untouched)...`);
  const deal = await temporalBridge.deployApp({ name: dep.name, clusterId: dep.clusterId, appType: dep.appType }, undefined);
  log(`Workflow started: ${deal.id}`);

  // Poll the actual k8s pod state directly rather than the DB status field (which only updates
  // on a slower reconciliation loop) — we want to know as soon as the container is Running.
  // Namespace = the sanitized deployment name (see DeployAppActivity's SANITIZE + main.ts's
  // DEPLOYMENT_NAME env var), NOT the app type — e.g. "Vllm-Production" -> "vllm-production".
  const kubeconfigPath = await clusterService.getKubeconfigPath(systemCluster);
  const namespace = dep.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const deadline = Date.now() + MAX_WAIT_MS;
  let podName: string | undefined;
  let podRunning = false;

  const CRASH_LOOP_THRESHOLD = 3; // container-level restarts, not pod-level phase
  while (Date.now() < deadline) {
    try {
      // No label filter — each deployment gets its own dedicated namespace, so any pod here
      // is THE pod. (The actual label turned out to be app=<namespace>-vllm, not app=vllm —
      // don't rely on it.)
      const podsJson = await infra.runKubectl(['get', 'pods', '-n', namespace, '-o', 'json'], kubeconfigPath);
      const pods = JSON.parse(podsJson).items || [];
      if (pods.length > 0) {
        podName = pods[0].metadata.name;
        const phase = pods[0].status?.phase;
        const containerStatus = pods[0].status?.containerStatuses?.[0];
        const restarts = containerStatus?.restartCount ?? 0;
        const ready = containerStatus?.ready ?? false;
        log(`Pod ${podName}: phase=${phase}, ready=${ready}, restarts=${restarts}`);

        // Pod-level phase stays "Running" even while the container inside is crash-looping —
        // require the container itself to report ready, not just the pod phase.
        if (phase === 'Running' && ready) {
          podRunning = true;
          break;
        }
        if (phase === 'Failed' || restarts >= CRASH_LOOP_THRESHOLD) {
          console.error(`🔴 FAIL: pod ${podName} is crash-looping (restarts=${restarts}) or Failed — the container is starting but not staying up.`);
          console.error(`Check: kubectl --context k3d-${SYSTEM_CLUSTER_ID} logs -n ${namespace} ${podName} --previous`);
          process.exit(1);
        }
      } else {
        log('Pod not scheduled yet...');
      }
    } catch (err: any) {
      log(`(poll error, retrying: ${err.message.split('\n')[0]})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!podRunning || !podName) {
    console.error(`🔴 FAIL: pod never reached Ready within ${MAX_WAIT_MS / 1000}s. Check: kubectl --context k3d-${SYSTEM_CLUSTER_ID} get pods -n ${namespace}`);
    process.exit(1);
  }
  log(`✅ Pod is Running — deploy succeeded (no k3d image-import crash).`);

  // The actual point of the whole session: does this container have real GPU device access?
  log('Verifying GPU device passthrough inside the container...');
  try {
    const nvidiaSmi = await infra.runKubectl(
      ['exec', '-n', namespace, podName, '--', 'nvidia-smi', '-L'],
      kubeconfigPath,
    );
    if (!nvidiaSmi.includes('GPU')) {
      throw new Error(`nvidia-smi ran but reported no GPUs: ${nvidiaSmi}`);
    }
    log(`nvidia-smi output:\n${nvidiaSmi}`);
    console.log('🟢 PASS: vLLM deployed onto the system cluster with real GPU device passthrough.');
    process.exit(0);
  } catch (err: any) {
    console.error(`🔴 FAIL: GPU device check failed inside the pod: ${err.message}`);
    console.error('This means the pod is running but WITHOUT real GPU access — the exact bug this session chased.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('🔴 FAIL (uncaught):', err);
  process.exit(1);
});
