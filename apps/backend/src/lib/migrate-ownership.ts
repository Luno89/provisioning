/**
 * One-time startup migration, run from bootstrap() before any request is served — see
 * types.ts's UserMetadata.isAdmin / ClusterMetadata.ownerId / DeploymentMetadata.ownerId for the
 * fields this backfills.
 *
 * This platform started single-user with no ownership tracking at all; per-user isolation
 * (ClusterService.getAll/getById filtering by ownerId) was added later. Without this migration,
 * every cluster/deployment created before that point would silently vanish from its actual
 * owner's view the moment isolation went live — filtered out because ownerId is unset, not
 * because it doesn't belong to them. Idempotent: safe to run on every startup, a no-op once
 * everything already has an owner.
 */
import type { Database } from './db-interface.js';

export async function migrateLegacyOwnership(db: Database): Promise<void> {
  const users = await db.getUsers();
  if (users.length === 0) return; // fresh install — nothing to backfill yet

  let admin = users.find((u) => u.isAdmin);
  if (!admin) {
    // Oldest account by createdAt — on an existing single-user install this is, definitionally,
    // the person who's been using it. On a fresh multi-user install the very first registration
    // becomes admin at registration time instead (see index.ts's /api/auth/register) and this
    // branch never fires.
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
