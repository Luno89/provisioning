import type { Database } from './db-interface.js';
import { resolveBindings } from './binding-resolve.js';

/**
 * Declaring that a project depends on a running service.
 *
 * ── WHY THIS IS A MODULE AND NOT A HANDLER IN TWO PLACES ──
 * Both surfaces need it. A planner in a branch declares a dependency while planning the work; Koala
 * in general chat needs to as well, or asking it "make github-mcp cache in mongo" produces a
 * plausible answer from something that quietly cannot act — it can SEE the database and not wire it
 * up.
 *
 * Copying thirty lines into the second runner is exactly the habit that produced five different
 * `svc.cluster.local` builders and two persona resolvers in this codebase, both of which drifted.
 * The refusals here are a security boundary, so a second copy that fell behind would be worse than
 * untidy.
 */

export interface DeclareResult {
  error?: string;
  note?: string;
  added?: { service: string; as: string; type: string };
  /** Where the app will find the binding, so it writes code against real paths. */
  readAt?: string;
  files?: string[];
}

export async function declareDependency(
  db: Pick<Database, 'getProjects' | 'saveProject' | 'getDeployments' | 'getAppSpecs'> & {
    getBindingTypes?: () => Promise<any[]>;
  },
  userId: string,
  args: { projectId?: unknown; service?: unknown; as?: unknown },
): Promise<DeclareResult> {
  // Owner-filtered, so another user's project id reads as "no such project" rather than as a
  // permission error — which would confirm it exists.
  const project = (await db.getProjects())
    .find((p) => p.id === String(args.projectId ?? '') && p.ownerId === userId);
  if (!project) return { error: 'No project with that id.' };

  const service = String(args.service ?? '').trim();
  const as = args.as ? String(args.as) : undefined;

  /**
   * Resolved now rather than only at deploy time, so a name that cannot be bound is refused while
   * the model still has the context to fix it. The same check runs again on deploy, because a
   * service can be destroyed between declaring the dependency and using it.
   */
  const dynamicTypes = db.getBindingTypes ? await db.getBindingTypes().catch(() => []) : [];
  const { bindings, problems } = resolveBindings(
    [{ service, ...(as ? { as } : {}) }],
    await db.getDeployments(),
    await db.getAppSpecs(),
    userId,
    { dynamicTypes },
  );
  if (!bindings.length) return { error: problems[0] ?? `Cannot bind to "${service}".` };

  const binding = bindings[0]!;
  const needs = project.needs ?? [];
  // A planner that re-reads its own board and calls again must not stack the same dependency.
  if (needs.some((n) => n.service === service)) {
    return { note: `This project already depends on "${service}".` };
  }

  await db.saveProject({
    ...project,
    needs: [...needs, { service, ...(as ? { as } : {}) }],
    updatedAt: new Date().toISOString(),
  } as typeof project);

  return {
    added: { service, as: binding.name, type: binding.type },
    readAt: `$SERVICE_BINDING_ROOT/${binding.name}/`,
    files: ['type', 'host', 'port', ...Object.keys(binding.source.keys)],
    note: 'Provided at deploy time. Read these files at runtime — do not hard-code the address '
      + 'or the credentials, and never commit them.',
  };
}
