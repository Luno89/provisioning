import type { Database } from './db-interface.js';

export async function migrateLegacyOwnership(db: Database): Promise<void> {
  const users = await db.getUsers();
  if (users.length === 0) return;

  let admin = users.find((u) => u.isAdmin);
  if (!admin) {
    admin = [...users].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    if (admin) {
      admin.isAdmin = true;
      await db.saveUser(admin);
      console.log(`[migrate-ownership] No admin user existed — promoted ${admin.email} (oldest account)`);
    }
  }
  if (!admin) return;

  const clusters = await db.getClusters();
  let clusterCount = 0;
  for (const cluster of clusters) {
    if (!cluster.ownerId) {
      cluster.ownerId = admin.id;
      await db.saveCluster(cluster);
      clusterCount++;
    }
  }

  const deployments = await db.getDeployments();
  let deploymentCount = 0;
  for (const deployment of deployments) {
    if (!deployment.ownerId) {
      deployment.ownerId = admin.id;
      await db.saveDeployment(deployment);
      deploymentCount++;
    }
  }

  if (clusterCount > 0 || deploymentCount > 0) {
    console.log(`[migrate-ownership] Backfilled ownerId on ${clusterCount} cluster(s) and ${deploymentCount} deployment(s) to admin ${admin.email}`);
  }
}
