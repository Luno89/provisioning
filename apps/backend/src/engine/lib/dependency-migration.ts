import type { Install, ToolDefinition, WorkspaceDependency } from '@koala/agent-engine';
import { runsFingerprint, type McpServerRecord } from './mcp-servers.js';
import { catalogueOf, dependencyNameFor } from './workspace-dependencies.js';

type LegacyTool = ToolDefinition & { install?: Install | undefined; needsBinaries?: string[] | undefined; provides?: string[] | undefined };
type LegacyRuns = Extract<McpServerRecord['runs'], { where: 'workspace' }> & { install?: Install[] | undefined; needsBinaries?: string[] | undefined };

export interface DependencyMigrationStore {
  accounts: {
    getUsers(): Promise<{ id: string }[]>;
  };
  getEngineTools(ownerId?: string): Promise<ToolDefinition[]>;
  saveEngineTool(tool: ToolDefinition): Promise<void>;
  getMcpServers(ownerId: string): Promise<McpServerRecord[]>;
  saveMcpServer(server: McpServerRecord): Promise<void>;
  getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]>;
  saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void>;
}

export interface DependencyMigration {
  toolsMoved: number;
  serversMoved: number;
  dependenciesMade: number;
  left: string[];
}

const sameInstalls = (a: readonly Install[], b: readonly Install[]): boolean => JSON.stringify(a) === JSON.stringify(b);

const PROGRAM = /^[A-Za-z0-9._+-]+$/;

export function programOf(start: string): string | undefined {
  const word = start.trim().split(/\s+/).find((token) => !token.includes('='));
  if (!word) return undefined;
  const name = word.split('/').pop() ?? word;
  return PROGRAM.test(name) && !['npx', 'node', 'python3', 'python', 'uvx', 'sh', 'bash', 'env'].includes(name) ? name : undefined;
}

export async function migrateToDependencies(store: DependencyMigrationStore, shipped: readonly WorkspaceDependency[]): Promise<DependencyMigration> {
  const out: DependencyMigration = { toolsMoved: 0, serversMoved: 0, dependenciesMade: 0, left: [] };
  const owned = new Map<string, WorkspaceDependency[]>();
  const ownOf = async (ownerId: string) => {
    if (!owned.has(ownerId)) owned.set(ownerId, await store.getWorkspaceDependencies(ownerId));
    return owned.get(ownerId)!;
  };

  const dependencyFor = async (ownerId: string | undefined, installs: readonly Install[], provides: readonly string[], named: string, summary: string): Promise<string | undefined> => {
    const real = installs.filter((install) => install.via !== 'base');
    if (real.length === 0) return undefined;
    const catalogue = ownerId ? catalogueOf(shipped, await ownOf(ownerId)) : [...shipped];
    const found = catalogue.find((dependency) => sameInstalls(dependency.install, real));
    if (found) return found.name;
    if (!ownerId) return undefined;
    if (provides.length === 0) return undefined;
    const taken = new Set(catalogue.map((dependency) => dependency.name));
    let name = dependencyNameFor(named);
    for (let n = 2; taken.has(name); n += 1) name = `${dependencyNameFor(named).slice(0, 36)}-${n}`;
    const made: WorkspaceDependency = { name, summary, provides: [...provides], install: real.map((install) => ({ ...install })) as Install[], ownerId };
    await store.saveWorkspaceDependency({ ...made, ownerId });
    (await ownOf(ownerId)).push(made);
    out.dependenciesMade += 1;
    return name;
  };

  for (const raw of (await store.getEngineTools()) as LegacyTool[]) {
    if (!raw.install && !raw.needsBinaries && !raw.provides) continue;
    const { install, needsBinaries, provides: _provides, ...tool } = raw;
    const named = install && install.via !== 'base' && install.via !== 'script' ? install.packages[0] ?? tool.name : tool.name;
    const need = install ? await dependencyFor(tool.ownerId, [install], needsBinaries ?? [], named, `What ${tool.name} needs: ${(needsBinaries ?? []).join(', ') || 'its install'}.`) : undefined;
    if (install && install.via !== 'base' && !need) {
      out.left.push(`the tool ${tool.name}${tool.ownerId ? '' : ' (shipped)'}: its install matches no dependency${needsBinaries?.length ? '' : ' and it names no program it gives'}`);
      continue;
    }
    await store.saveEngineTool({ ...tool, ...(need ? { needs: [...new Set([...(tool.needs ?? []), need])] } : {}) });
    out.toolsMoved += 1;
  }

  for (const { id: ownerId } of await store.accounts.getUsers()) {
    for (const server of await store.getMcpServers(ownerId)) {
      if (server.runs.where !== 'workspace') continue;
      const legacy = server.runs as LegacyRuns;
      if (!legacy.install && !legacy.needsBinaries) continue;
      const before = runsFingerprint(server.runs);
      const { install, needsBinaries, ...runs } = legacy;
      const fromTemplate = server.from && 'template' in server.from && server.from.template === 'playwright' ? 'playwright-mcp' : undefined;
      const provides = needsBinaries?.length ? needsBinaries : [programOf(legacy.start)].filter((name): name is string => Boolean(name));
      const need = fromTemplate ?? await dependencyFor(ownerId, install ?? [], provides, `${server.name}-server`, `What the MCP server ${server.name} needs to run.`);
      if (install?.some((step) => step.via !== 'base') && !need) {
        out.left.push(`the MCP server ${server.name}: its install matches no dependency and nothing says which program it gives`);
        continue;
      }
      const next: McpServerRecord = { ...server, runs: { ...runs, needs: [...new Set([...(runs.needs ?? []), ...(need ? [need] : [])])] } };
      const after = runsFingerprint(next.runs);
      await store.saveMcpServer({
        ...next,
        ...(server.captured?.fingerprint === before ? { captured: { ...server.captured, fingerprint: after } } : {}),
        ...(server.failed?.fingerprint === before ? { failed: { ...server.failed, fingerprint: after } } : {}),
      });
      out.serversMoved += 1;
    }
  }
  return out;
}
