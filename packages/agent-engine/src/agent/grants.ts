import type { Persona, PersonaRecord } from './agent.js';

export type GrantKind = 'tool' | 'server';

export interface ToolGrant {
  ownerId?: string | undefined;
  agent: string;
  tool: string;
  kind?: GrantKind | undefined;
  revoked?: boolean | undefined;
  grantedAt?: string | undefined;
  why?: string | undefined;
  proposalId?: string | undefined;
}

export type ToolSource = 'shipped' | 'granted' | 'revoked';

export interface SourcedTool {
  tool: string;
  source: ToolSource;
}

export interface GrantChanges {
  grant: string[];
  revoke: string[];
  drop: string[];
}

export const kindOfGrant = (grant: Pick<ToolGrant, 'kind'>): GrantKind => grant.kind ?? 'tool';

const forAgent = (grants: readonly ToolGrant[], slug: string, kind: GrantKind): ToolGrant[] =>
  grants.filter((grant) => grant.agent === slug && kindOfGrant(grant) === kind);

export function sourcedTools(slug: string, shipped: readonly ToolGrant[], person: readonly ToolGrant[], kind: GrantKind = 'tool'): SourcedTool[] {
  const mine = forAgent(person, slug, kind);
  const revoked = new Set(mine.filter((grant) => grant.revoked).map((grant) => grant.tool));
  const listed: SourcedTool[] = [];
  const seen = new Set<string>();
  for (const grant of forAgent(shipped, slug, kind)) {
    if (seen.has(grant.tool)) continue;
    seen.add(grant.tool);
    listed.push({ tool: grant.tool, source: revoked.has(grant.tool) ? 'revoked' : 'shipped' });
  }
  for (const grant of mine) {
    if (grant.revoked || seen.has(grant.tool)) continue;
    seen.add(grant.tool);
    listed.push({ tool: grant.tool, source: 'granted' });
  }
  return listed;
}

export function toolsOf(slug: string, shipped: readonly ToolGrant[], person: readonly ToolGrant[], kind: GrantKind = 'tool'): string[] {
  return sourcedTools(slug, shipped, person, kind).filter((entry) => entry.source !== 'revoked').map((entry) => entry.tool);
}

export function withTools(record: PersonaRecord, tools: readonly string[], servers: readonly string[] = []): Persona {
  return { ...record, tools: [...tools], servers: [...servers] };
}

export function withGrants(records: readonly PersonaRecord[], shipped: readonly ToolGrant[], person: readonly ToolGrant[]): Persona[] {
  return records.map((record) => withTools(record, toolsOf(record.slug, shipped, person), toolsOf(record.slug, shipped, person, 'server')));
}

export function grantChanges(slug: string, wanted: readonly string[], shipped: readonly ToolGrant[], person: readonly ToolGrant[], kind: GrantKind = 'tool'): GrantChanges {
  const want = new Set(wanted);
  const builtIn = new Set(forAgent(shipped, slug, kind).map((grant) => grant.tool));
  const mine = forAgent(person, slug, kind);
  const granted = new Set(mine.filter((grant) => !grant.revoked).map((grant) => grant.tool));
  const revoked = new Set(mine.filter((grant) => grant.revoked).map((grant) => grant.tool));

  const grant = [...want].filter((tool) => !builtIn.has(tool) && !granted.has(tool));
  const revoke = [...builtIn].filter((tool) => !want.has(tool) && !revoked.has(tool));
  const drop = [
    ...[...granted].filter((tool) => !want.has(tool) || builtIn.has(tool)),
    ...[...revoked].filter((tool) => want.has(tool) || !builtIn.has(tool)),
  ];
  return { grant, revoke, drop };
}

export function toRecord(persona: Persona | PersonaRecord): PersonaRecord {
  const { tools: _tools, servers: _servers, ...record } = persona as Persona;
  return record;
}

export type GrantMap = Readonly<Record<string, readonly string[]>>;

export function grantsFrom(map: GrantMap): ToolGrant[] {
  return Object.entries(map).flatMap(([agent, tools]) => tools.map((tool) => ({ agent, tool })));
}
