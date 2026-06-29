import path from 'path';
import { fileURLToPath } from 'url';
import { LocalDB } from '../apps/backend/src/lib/db.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ClusterService } from '../apps/backend/src/services/ClusterService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log('🚀 Initializing services for integration test...');
  const db = new LocalDB();
  await db.init();

  const infra = new InfrastructureService();
  const clusterService = new ClusterService(db, infra);

  const clusterName = `test-infra-${Math.floor(Math.random() * 1000)}`;
  console.log(`🔨 Provisioning test cluster: ${clusterName}...`);

  let metadata: any = null;
  let succeeded = false;

  try {
    metadata = await clusterService.provision(clusterName, 'k3d');
    console.log('⏳ Provisioning started in background. Monitoring status...');
    
    // Poll the status
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const clusters = await clusterService.getAll();
      const current = clusters.find(c => c.name === clusterName);
      
      if (!current) {
        console.log('❌ Cluster not found in database!');
        break;
      }
      
      console.log(`⏱️ Current status: ${current.status}`);
      if (current.status === 'healthy') {
        succeeded = true;
        break;
      } else if (current.status === 'failed') {
        break;
      }
    }

    if (succeeded) {
      console.log('✅ Cluster successfully provisioned!');
    } else {
      console.error('❌ Cluster provisioning failed or timed out!');
    }

  } catch (err: any) {
    console.error('❌ Integration test encountered an error during provisioning:', err.message);
  } finally {
    console.log(`🧹 Deleting test cluster: ${clusterName}...`);
    try {
      if (metadata && metadata.id) {
        await clusterService.delete(metadata.id);
        
        // Poll deletion status
        let deleted = false;
        for (let i = 0; i < 40; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const clusters = await clusterService.getAll();
          const current = clusters.find(c => c.name === clusterName);
          
          if (!current) {
            deleted = true;
            break;
          }
          console.log(`⏱️ Deleting status...`);
        }

        if (deleted) {
          console.log('✨ Cluster successfully deleted and cleaned up.');
        } else {
          console.error('⚠️ Timeout waiting for cluster deletion in database. Forcing physical deletion...');
          try {
            await infra.deleteLocalCluster(clusterName);
          } catch {}
        }
      } else {
        console.log('Forcing physical cleanup of cluster nodes...');
        try {
          await infra.deleteLocalCluster(clusterName);
        } catch {}
      }
    } catch (cleanupErr: any) {
      console.error('❌ Error during cleanup:', cleanupErr.message);
    }

    // Exit with appropriate status code
    process.exit(succeeded ? 0 : 1);
  }
}

run();
