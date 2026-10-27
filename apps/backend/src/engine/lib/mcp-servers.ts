import { createHash } from 'node:crypto';
import { DEFAULT_BASE, DEPENDENCY_NAME, LANGUAGE_IDS, UnbuildableError, planImage, type BaseImage, type ImagePlan, type Need, type WorkspaceDependency } from '@koala/agent-engine';
import type { McpTool, McpToolAnnotations } from './mcp-client.js';

export type McpToolKind = 'read-only' | 'safe-write' | 'destructive';
export const MCP_TOOL_KINDS: readonly McpToolKind[] = ['read-only', 'safe-write', 'destructive'];

export type ServerRuns =
  | { where: 'hosted'; url: string }
  | { where: 'hosted'; deploymentId: string }
  | {
    where: 'workspace';
    languages?: string[] | undefined;
    needs: string[];
    start: string;
    port: number;
    path?: string | undefined;
  };

export interface CapturedServer {
  instructions?: string | undefined;
  serverInfo?: { name?: string | undefined; version?: string | undefined } | undefined;
  tools: McpTool[];
  at: string;
  fingerprint: string;
}

export interface McpServerRecord {
  id: string;
  ownerId: string;
  name: string;
  summary?: string | undefined;
  runs: ServerRuns;
  offer?: string[] | undefined;
  omit?: string[] | undefined;
  notes?: string | undefined;
  dependsOn?: string | undefined;
  tools?: Record<string, { note?: string | undefined; kind?: McpToolKind | undefined }> | undefined;
  captured?: CapturedServer | undefined;
  failed?: { at: string; why: string; fingerprint: string } | undefined;
  capturing?: { runId: string; at: string } | undefined;
  from?: { template: string } | { projectId: string } | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerTemplate {
  id: string;
  name: string;
  summary: string;
  runs: ServerRuns;
  offer?: string[] | undefined;
  omit?: string[] | undefined;
  notes?: string | undefined;
}

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const DEFAULT_PATH = '/mcp';

export const serverPath = (runs: Extract<ServerRuns, { where: 'workspace' }>): string => runs.path ?? DEFAULT_PATH;

export function runsFingerprint(runs: ServerRuns): string {
  return createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 16);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);

function needsProblems(needs: unknown): string[] {
  if (!Array.isArray(needs) || needs.length === 0) return ['a workspace server has to name the dependencies that install it'];
  return needs.flatMap((need) => (typeof need === 'string' && DEPENDENCY_NAME.test(need) ? [] : [`"${String(need)}" is not a dependency name`]));
}

export function runsProblems(runs: unknown): string[] {
  if (!isRecord(runs)) return ['say where the server runs: hosted, at a URL or one of your deployments, or in the workspace'];
  if (runs.where === 'hosted') {
    if (typeof runs.url === 'string') {
      try {
        const url = new URL(runs.url);
        return url.protocol === 'http:' || url.protocol === 'https:' ? [] : ['a hosted server\'s URL has to be http or https'];
      } catch {
        return [`"${runs.url}" is not a URL`];
      }
    }
    return typeof runs.deploymentId === 'string' && runs.deploymentId ? [] : ['a hosted server needs its URL or the deployment it is'];
  }
  if (runs.where !== 'workspace') return ['a server runs hosted or in the workspace'];
  const problems = needsProblems(runs.needs);
  if (typeof runs.start !== 'string' || !runs.start.trim()) problems.push('say the command that starts the server');
  if (!Number.isInteger(runs.port) || (runs.port as number) < 1024 || (runs.port as number) > 65535) problems.push('the port has to be a whole number from 1024 to 65535');
  if (runs.path !== undefined && (typeof runs.path !== 'string' || !runs.path.startsWith('/'))) problems.push('the path has to start with /');
  if (runs.languages !== undefined && (!names(runs.languages) || runs.languages.some((language) => !LANGUAGE_IDS.includes(language)))) problems.push(`languages can be ${LANGUAGE_IDS.join(', ')}`);
  return problems;
}

export function serverProblems(server: Pick<McpServerRecord, 'name' | 'runs' | 'offer' | 'omit' | 'tools'>, others: readonly Pick<McpServerRecord, 'id' | 'name'>[] = [], id?: string): string[] {
  const problems: string[] = [];
  if (typeof server.name !== 'string' || !NAME.test(server.name)) problems.push('the name has to be 2 to 31 lowercase letters, digits or dashes, starting with a letter: its tools are offered as <name>__<tool>');
  else if (others.some((other) => other.name === server.name && other.id !== id)) problems.push(`you already have a server called ${server.name}`);
  problems.push(...runsProblems(server.runs));
  if (server.offer !== undefined && !names(server.offer)) problems.push('offer has to be a list of tool names');
  if (server.omit !== undefined && !names(server.omit)) problems.push('omit has to be a list of tool names');
  if (server.offer !== undefined && server.omit !== undefined) problems.push('say which tools to offer or which to omit, not both');
  for (const [tool, said] of Object.entries(server.tools ?? {})) {
    if (said.kind !== undefined && !MCP_TOOL_KINDS.includes(said.kind)) problems.push(`${tool}: a kind is read-only, safe-write or destructive`);
  }
  return problems;
}

export const offers = (server: Pick<McpServerRecord, 'offer' | 'omit'>, tool: string): boolean =>
  (server.offer === undefined || server.offer.includes(tool)) && !(server.omit ?? []).includes(tool);

export type ServerState =
  | { state: 'capturing'; runId: string }
  | { state: 'captured'; tools: number }
  | { state: 'failed'; why: string }
  | { state: 'stale' }
  | { state: 'new' };

export function serverState(server: McpServerRecord): ServerState {
  const fingerprint = runsFingerprint(server.runs);
  if (server.capturing) return { state: 'capturing', runId: server.capturing.runId };
  if (server.failed && server.failed.fingerprint === fingerprint && (!server.captured || server.failed.at > server.captured.at)) return { state: 'failed', why: server.failed.why };
  if (server.captured && server.captured.fingerprint === fingerprint) return { state: 'captured', tools: server.captured.tools.filter((tool) => offers(server, tool.name)).length };
  if (server.captured) return { state: 'stale' };
  return { state: 'new' };
}

export function usable(server: McpServerRecord): boolean {
  const fingerprint = runsFingerprint(server.runs);
  if (!server.captured || server.captured.fingerprint !== fingerprint) return false;
  return !(server.failed && server.failed.fingerprint === fingerprint && server.failed.at > server.captured.at);
}

export const captureRunId = (serverId: string, fingerprint: string, at: number): string => `mcp-capture-${serverId}-${fingerprint.slice(0, 8)}-${at.toString(36)}`;

export type WorkspaceRuns = Extract<ServerRuns, { where: 'workspace' }>;

export const isWorkspaceServer = (server: Pick<McpServerRecord, 'runs'>): server is McpServerRecord & { runs: WorkspaceRuns } => server.runs.where === 'workspace';

export const serverSource = (name: string): string => `server:${name}`;

export function serverNeeds(server: Pick<McpServerRecord, 'name' | 'runs'>): Need[] {
  if (server.runs.where !== 'workspace') return [];
  return server.runs.needs.map((name) => ({ name, from: serverSource(server.name) }));
}

export function planServerImage(runs: WorkspaceRuns, name: string, bases: readonly BaseImage[], dependencies: readonly WorkspaceDependency[]): ImagePlan {
  const languages = runs.languages ?? [];
  const base = languages.find((language) => bases.some((candidate) => candidate.id === language)) ?? DEFAULT_BASE;
  const plan = planImage({ base, languages, tools: [], needs: serverNeeds({ name, runs }), bases, dependencies });
  if (!plan.provides.includes('curl')) throw new UnbuildableError(`${name} is reached with curl, which its workspace does not have`);
  return plan;
}

export function withKind(declared: McpToolAnnotations | undefined, kind: McpToolKind | undefined): McpToolAnnotations | undefined {
  if (!kind) return declared;
  if (kind === 'read-only') return { ...declared, readOnlyHint: true, destructiveHint: false };
  return { ...declared, readOnlyHint: false, destructiveHint: kind === 'destructive' };
}

export function toolAnnotations(server: Pick<McpServerRecord, 'runs' | 'tools'>, tool: Pick<McpTool, 'name' | 'annotations'>): McpToolAnnotations | undefined {
  const kind = server.tools?.[tool.name]?.kind;
  if (kind || server.runs.where !== 'hosted') return withKind(tool.annotations, kind);
  return withKind(tool.annotations, 'destructive');
}

export function kindOfTool(annotations: McpToolAnnotations | undefined): McpToolKind {
  if (annotations?.readOnlyHint === true) return 'read-only';
  return annotations?.destructiveHint === false ? 'safe-write' : 'destructive';
}

export function serverNameFrom(slug: string, taken: ReadonlySet<string>): string {
  const base = (/^[a-z]/.test(slug) ? slug : `s-${slug}`).slice(0, 28).replace(/-+$/, '') || 'server';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export const deploymentOf = (server: Pick<McpServerRecord, 'runs'>): string | undefined =>
  (server.runs.where === 'hosted' && 'deploymentId' in server.runs ? server.runs.deploymentId : undefined);
