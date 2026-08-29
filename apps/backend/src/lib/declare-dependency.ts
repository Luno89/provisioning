import type { Database } from './db-interface.js';
import { resolveBindings } from './binding-resolve.js';

export interface DeclareResult {
  error?: string;
  note?: string;
  added?: { service: string; as: string; type: string };
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
  const project = (await db.getProjects())
    .find((p) => p.id === String(args.projectId ?? '') && p.ownerId === userId);
  if (!project) return { error: 'No project with that id.' };

  const service = String(args.service ?? '').trim();
  const as = args.as ? String(args.as) : undefined;

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
