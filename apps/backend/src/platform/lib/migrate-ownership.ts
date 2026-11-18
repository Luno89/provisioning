import type { Database } from './db-interface.js';
import { runOnce } from './migrations.js';
import { holds, principalOf, type ClaimSettings } from './permissions.js';
import type { UserMetadata } from './types.js';

async function firstOperator(db: Database, claims: ClaimSettings): Promise<UserMetadata | undefined> {
  const users = (await db.accounts.getUsers()).filter((user) => !user.space);
  const byAge = [...users].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return byAge.find((user) => holds(principalOf(user, claims), 'operator'));
}

async function ownUnownedClustersAndApps(db: Database, claims: ClaimSettings): Promise<Record<string, number>> {
  const clusters = (await db.infrastructure.getClusters()).filter((cluster) => !cluster.ownerId);
  const deployments = (await db.infrastructure.getDeployments()).filter((deployment) => !deployment.ownerId);
  const unowned = clusters.length + deployments.length;
  if (unowned === 0) return { owned: 0 };
  const operator = await firstOperator(db, claims);
  if (!operator) return { owned: 0, left: unowned };
  for (const cluster of clusters) await db.infrastructure.saveCluster({ ...cluster, ownerId: operator.id });
  for (const deployment of deployments) await db.infrastructure.saveDeployment({ ...deployment, ownerId: operator.id });
  console.log(`[migrate-ownership] Gave ${clusters.length} cluster(s) and ${deployments.length} deployment(s) with no owner to the operator ${operator.email}`);
  return { owned: unowned };
}

export const migrateLegacyOwnership = (db: Database, claims: ClaimSettings, now: string): Promise<Record<string, number>> =>
  runOnce(db.platform, 'clusters-and-apps-owned', now, () => ownUnownedClustersAndApps(db, claims));

export async function ownUnownedProjects(db: Database, claims: ClaimSettings): Promise<Record<string, number>> {
  const unowned = (await db.projects.getProjects()).filter((project) => !project.ownerId);
  if (unowned.length === 0) return { owned: 0 };
  const operator = await firstOperator(db, claims);
  if (!operator) return { owned: 0, left: unowned.length };
  for (const project of unowned) await db.projects.saveProjectInfo({ id: project.id, ownerId: operator.id });
  console.log(`[migrate-ownership] Gave ${unowned.length} project(s) with no owner to the operator ${operator.email}`);
  return { owned: unowned.length };
}

export const operatorsFromAdmins = (db: Pick<Database, 'accounts' | 'platform'>, now: string): Promise<Record<string, number>> =>
  runOnce(db.platform, 'operators-from-admins', now, async () => ({ granted: await db.accounts.grantOperatorToAdmins() }));
