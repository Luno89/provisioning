import type { Database } from './db-interface.js';
import { holds, principalOf, type ClaimSettings } from './permissions.js';
import type { UserMetadata } from './types.js';

const holdsAccounts = (claims: ClaimSettings): boolean => claims.role === 'root' || claims.role === 'combined';

async function firstOperator(db: Database, claims: ClaimSettings): Promise<UserMetadata | undefined> {
  const users = (await db.accounts.getUsers()).filter((user) => !user.space);
  const byAge = [...users].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const operator = byAge.find((user) => holds(principalOf(user, claims), 'operator'));
  if (operator || !holdsAccounts(claims)) return operator;
  const oldest = byAge[0];
  if (!oldest) return undefined;
  await db.accounts.saveUser({ ...oldest, isAdmin: true });
  console.log(`[migrate-ownership] No operator existed — made ${oldest.email} (oldest account) the operator`);
  return oldest;
}

export async function migrateLegacyOwnership(db: Database, claims: ClaimSettings): Promise<void> {
  const operator = await firstOperator(db, claims);
  if (!operator) return;

  let clusterCount = 0;
  for (const cluster of await db.infrastructure.getClusters()) {
    if (cluster.ownerId) continue;
    await db.infrastructure.saveCluster({ ...cluster, ownerId: operator.id });
    clusterCount++;
  }

  let deploymentCount = 0;
  for (const deployment of await db.infrastructure.getDeployments()) {
    if (deployment.ownerId) continue;
    await db.infrastructure.saveDeployment({ ...deployment, ownerId: operator.id });
    deploymentCount++;
  }

  if (clusterCount > 0 || deploymentCount > 0) {
    console.log(`[migrate-ownership] Backfilled ownerId on ${clusterCount} cluster(s) and ${deploymentCount} deployment(s) to the operator ${operator.email}`);
  }
}

export async function ownUnownedProjects(db: Database, claims: ClaimSettings): Promise<Record<string, number>> {
  const unowned = (await db.projects.getProjects()).filter((project) => !project.ownerId);
  if (unowned.length === 0) return { owned: 0 };
  const operator = await firstOperator(db, claims);
  if (!operator) return { owned: 0, left: unowned.length };
  for (const project of unowned) await db.projects.saveProjectInfo({ id: project.id, ownerId: operator.id });
  console.log(`[migrate-ownership] Gave ${unowned.length} project(s) with no owner to the operator ${operator.email}`);
  return { owned: unowned.length };
}
