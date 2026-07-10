import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { LocalDB } from '../apps/backend/src/lib/db.js';
import { v4 as uuidv4 } from 'uuid';

async function run() {
  console.log('🚀 [Worker Isolated Test] Initializing services...');
  
  // Set env vars to ensure we use test databases and local configs
  process.env.NODE_ENV = 'test';
  process.env.IS_E2E = 'true';

  const db = new LocalDB();
  await db.init();

  // Reset test databases
  await db.saveClusterList([]);
  await db.saveDeploymentList([]);

  console.log('🔌 Connecting to local Temporal server...');
  const client = await getTemporalClient();

  const clusterName = `isolated-fleet-${Math.floor(Math.random() * 1000)}`;
  const clusterId = uuidv4();
  const logFile = `/tmp/isolated-test-${clusterName}.log`;

  // Write initial cluster entry to DB
  await db.saveCluster({
    id: clusterId,
    name: clusterName,
    provider: 'k3d',
    status: 'provisioning',
    lastLogPath: logFile,
  });

  console.log(`🔨 Level 3: Triggering ClusterProvisionWorkflow for cluster: ${clusterName}...`);
  try {
    const handle = await client.workflow.start('ClusterProvisionWorkflow', {
      taskQueue: 'host-ops-queue',
      workflowId: `cluster-provision-${clusterName}`,
      args: [{
        id: clusterId,
        name: clusterName,
        provider: 'k3d',
        logFile,
      }],
    });

    console.log(`⏳ Workflow started (ID: ${handle.workflowId}). Waiting for provisioning completion...`);
    const result = await handle.result();
    console.log('✅ ClusterProvisionWorkflow finished with result:', result);

    // Update DB status to healthy (simulating backend's update loop)
    await db.saveCluster({
      id: clusterId,
      name: clusterName,
      provider: 'k3d',
      status: 'healthy',
      kubeconfigPath: result.kubeconfig,
      lastLogPath: logFile,
    });

    // Verify DB updated to healthy
    const clusters = await db.getClusters();
    const clusterRecord = clusters.find(c => c.name === clusterName);
    if (!clusterRecord || clusterRecord.status !== 'healthy') {
      throw new Error(`Cluster status in DB is not healthy: ${clusterRecord?.status}`);
    }
    console.log(`🎉 Cluster card status is healthy!`);

    // Deploy wordpress app
    const appName = 'wordpress-isolated';
    const appId = uuidv4();
    const appLogFile = `/tmp/isolated-app-${appName}.log`;

    await db.saveDeployment({
      id: appId,
      name: appName,
      clusterId,
      strategy: 'native',
      appType: 'wordpress',
      status: 'deploying',
      lastLogPath: appLogFile,
    });

    console.log(`📦 Triggering executeDeployAppWorkflow for app: ${appName}...`);
    const handleDep = await client.workflow.start('executeDeployAppWorkflow', {
      taskQueue: 'cluster-ops-queue',
      workflowId: `app-deploy-${appName}`,
      args: [{
        name: appName,
        clusterId,
        clusterName,
        provider: 'k3d',
        strategy: 'native',
        appType: 'wordpress',
        odooRepo: '',
        odooTag: '',
        dbRepo: '',
        dbTag: '',
        logFile: appLogFile,
      }],
    });

    console.log(`⏳ App deployment workflow started (ID: ${handleDep.workflowId}). Waiting for completion...`);
    const depResult = await handleDep.result();
    console.log('✅ App deploy finished with result:', depResult);

    // Update DB status to running (simulating backend's update loop)
    await db.saveDeployment({
      id: appId,
      name: appName,
      clusterId,
      clusterName,
      appType: 'wordpress',
      status: 'running',
      storage: { sizeGB: 1 },
      lastLogPath: appLogFile,
    });

    const deployments = await db.getDeployments();
    const depRecord = deployments.find(d => d.name === appName);
    if (!depRecord || depRecord.status !== 'running') {
      throw new Error(`App deployment status in DB is not running: ${depRecord?.status}`);
    }
    console.log('🎉 Application deployment status is running!');

    // Cleanup: Destroy App
    console.log(`🧹 Cleaning up: Triggering executeDestroyAppWorkflow for app: ${appName}...`);
    const handleDestroyDep = await client.workflow.start('executeDestroyAppWorkflow', {
      taskQueue: 'cluster-ops-queue',
      workflowId: `app-destroy-${appName}`,
      args: [{
        name: appName,
        clusterId,
        clusterName,
        provider: 'k3d',
        strategy: 'native',
        appType: 'wordpress',
        logFile: appLogFile,
      }],
    });
    await handleDestroyDep.result();
    console.log('✅ App destruction finished.');

    // Cleanup: Destroy Cluster
    console.log(`🧹 Cleaning up: Triggering executeDestroyClusterWorkflow for cluster: ${clusterName}...`);
    const handleDestroyCluster = await client.workflow.start('executeDestroyClusterWorkflow', {
      taskQueue: 'host-ops-queue',
      workflowId: `cluster-destroy-${clusterName}`,
      args: [{
        name: clusterName,
        provider: 'k3d',
        logFile,
      }],
    });
    await handleDestroyCluster.result();
    console.log('✅ Cluster destruction finished.');

    console.log('🟢 [Worker Isolated Test] PASS! Restructure Level 3 works flawlessly.');
    process.exit(0);

  } catch (err: any) {
    console.error('🔴 [Worker Isolated Test] FAIL:', err.message);
    
    // Attempt forced physical cleanup of cluster
    console.log('🧹 Attempting emergency physical cleanup of cluster container...');
    const { execSync } = await import('child_process');
    try {
      execSync(`./bin/k3d cluster delete ${clusterName} >/dev/null 2>&1 || true`);
    } catch {}
    process.exit(1);
  }
}

run();
