import { createHash } from 'node:crypto';

/**
 * The id that names a deployment's Terraform stack, and therefore its state file.
 *
 * ── THE RACE THIS REPLACES ──
 * It was minted, not derived:
 *
 *     const deploymentId = dep.deploymentId || Math.random().toString(36).slice(2, 10);
 *
 * A read-modify-write with a random fallback. Four commits landed together, each build triggered a
 * deploy, and three deploy workflows started within 90 milliseconds — `14:40:43.086`, `.143`,
 * `.174`. All three read a record with no `deploymentId` and each invented its own.
 *
 * The result was four Terraform stacks for one deployment:
 *
 *     ...-8fg9h9hg.tfstate   created the namespace and the ingress
 *     ...-x87g6b77.tfstate   empty
 *     ...-oglj2dos.tfstate   empty
 *     ...-zr1d09s7.tfstate   what the record ended up pointing at
 *
 * From then on every deploy ran against an empty state and tried to create a namespace that
 * already existed:
 *
 *     Error: namespaces "github-mcp" already exists
 *
 * It never recovered, and nothing said why. The 54 deploy retries this caused were not retrying a
 * transient fault; they were retrying an unwinnable create.
 *
 * ── WHY DERIVED FIXES IT ──
 * Concurrency stops mattering when there is nothing to race for. Three workflows computing the
 * same id from the same deployment agree without coordinating, so the second and third become
 * updates to one state rather than creates against three empty ones.
 *
 * The same shape as the `build-<repo>-<commit8>` job-name collision fixed earlier: an identifier
 * that must be stable should be a function of the thing it identifies, never of the moment it was
 * first needed.
 */

/**
 * A stable, filesystem-safe id for a deployment.
 *
 * A hash rather than the name itself: the id becomes part of a Terraform stack name and a file on
 * disk, and deployment names contain characters that are legal in Kubernetes and awkward in both.
 * Eight hex characters is the same width the random version used, so nothing downstream that
 * assumed a length changes.
 */
export function deriveDeploymentId(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

/**
 * The id a deploy should use.
 *
 * A stored id ALWAYS wins, and that is a migration decision rather than a stylistic one: every
 * deployment already running has a state file keyed by whatever random id it was given. Deriving a
 * fresh one for those would point them all at empty states and have them try to recreate
 * themselves — the exact failure being fixed, inflicted on everything at once.
 *
 * So: existing deployments keep their state, new ones get an id that cannot race, and the window
 * where the id is absent — the only place the race lived — closes.
 */
export function deploymentIdFor(
  stored: string | undefined,
  identity: string,
): string {
  return stored || deriveDeploymentId(identity);
}
