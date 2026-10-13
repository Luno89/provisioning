import {
  grantChanges,
  kindOfGrant,
  sourcedTools,
  withGrants,
  type GrantKind,
  type Persona,
  type PersonaRecord,
  type SourcedTool,
  type ToolGrant,
} from '@koala/agent-engine';
import type { HiddenVocabulary } from '../../lib/extension-settings.js';
import { seededGrants, seededPersonas } from '../../extensions/seeds.js';

export interface AgentRecordStore {
  list(ownerId: string): Promise<PersonaRecord[]>;
}

export interface ToolGrantStore {
  list(ownerId: string): Promise<ToolGrant[]>;
  save(grant: ToolGrant & { ownerId: string }): Promise<void>;
  remove(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void>;
  removeAll(ownerId: string, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number>;
}

export interface AgentReadOptions {
  withHidden?: boolean | undefined;
}

export interface GrantMeta {
  why?: string | undefined;
  proposalId?: string | undefined;
}

export interface SourcedAgents {
  agents: Persona[];
  sources: Record<string, SourcedTool[]>;
  serverSources: Record<string, SourcedTool[]>;
}

export interface AgentDirectory {
  agents(ownerId: string, options?: AgentReadOptions): Promise<Persona[]>;
  sourced(ownerId: string, options?: AgentReadOptions): Promise<SourcedAgents>;
  setTools(ownerId: string, slug: string, wanted: readonly string[], meta?: GrantMeta): Promise<boolean>;
  setServers(ownerId: string, slug: string, wanted: readonly string[], meta?: GrantMeta): Promise<boolean>;
  renameServer(ownerId: string, from: string, to: string): Promise<number>;
  forgetServer(ownerId: string, name: string): Promise<number>;
  forgetAgent(ownerId: string, slug: string): Promise<number>;
  forgetTool(ownerId: string, tool: string): Promise<number>;
}

export interface AgentDirectoryOptions {
  records: AgentRecordStore;
  grants: ToolGrantStore;
  hidden?: ((ownerId: string) => Promise<HiddenVocabulary>) | undefined;
  builtIn?: (() => readonly PersonaRecord[]) | undefined;
  shipped?: (() => readonly ToolGrant[]) | undefined;
  now?: (() => string) | undefined;
  onChanged?: ((ownerId: string) => void) | undefined;
}

export function createAgentDirectory(options: AgentDirectoryOptions): AgentDirectory {
  const builtIn = options.builtIn ?? seededPersonas;
  const shippedAll = options.shipped ?? seededGrants;
  const now = options.now ?? (() => new Date().toISOString());
  const forget = async (ownerId: string, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number> => {
    const removed = await options.grants.removeAll(ownerId, of);
    if (removed > 0) options.onChanged?.(ownerId);
    return removed;
  };

  const setGranted = async (ownerId: string, slug: string, wanted: readonly string[], kind: GrantKind, meta: GrantMeta): Promise<boolean> => {
    const shipped = shippedAll();
    const person = await options.grants.list(ownerId);
    const changes = grantChanges(slug, wanted, shipped, person, kind);
    const at = now();
    const extra = { ...(meta.why ? { why: meta.why } : {}), ...(meta.proposalId ? { proposalId: meta.proposalId } : {}), ...(kind === 'server' ? { kind } : {}) };
    for (const tool of changes.drop) await options.grants.remove(ownerId, slug, tool, kind);
    for (const tool of changes.grant) await options.grants.save({ ownerId, agent: slug, tool, grantedAt: at, ...extra });
    for (const tool of changes.revoke) await options.grants.save({ ownerId, agent: slug, tool, revoked: true, grantedAt: at, ...extra });
    const changed = changes.grant.length + changes.revoke.length + changes.drop.length > 0;
    if (changed) options.onChanged?.(ownerId);
    return changed;
  };

  const view = async (ownerId: string, read: AgentReadOptions = {}) => {
    const hidden = !read.withHidden && options.hidden ? await options.hidden(ownerId) : undefined;
    const shown = (slug: string) => !hidden?.agents.has(slug);
    const records = [
      ...builtIn().filter((record) => shown(record.slug)),
      ...(await options.records.list(ownerId)).filter((record) => record.ownerId !== undefined && shown(record.slug)),
    ];
    const usable = (grant: ToolGrant) => kindOfGrant(grant) === 'server' || !hidden?.tools.has(grant.tool);
    return {
      records,
      shipped: shippedAll().filter(usable),
      person: (await options.grants.list(ownerId)).filter(usable),
    };
  };

  return {
    async agents(ownerId, read) {
      const { records, shipped, person } = await view(ownerId, read);
      return withGrants(records, shipped, person);
    },

    async sourced(ownerId, read) {
      const { records, shipped, person } = await view(ownerId, read);
      const sources: Record<string, SourcedTool[]> = {};
      const serverSources: Record<string, SourcedTool[]> = {};
      for (const record of records) {
        sources[record.slug] ??= sourcedTools(record.slug, shipped, person);
        serverSources[record.slug] ??= sourcedTools(record.slug, shipped, person, 'server');
      }
      return { agents: withGrants(records, shipped, person), sources, serverSources };
    },

    setTools: (ownerId, slug, wanted, meta = {}) => setGranted(ownerId, slug, wanted, 'tool', meta),

    setServers: (ownerId, slug, wanted, meta = {}) => setGranted(ownerId, slug, wanted, 'server', meta),

    async renameServer(ownerId, from, to) {
      const moving = (await options.grants.list(ownerId)).filter((grant) => kindOfGrant(grant) === 'server' && grant.tool === from);
      for (const grant of moving) {
        await options.grants.remove(ownerId, grant.agent, from, 'server');
        await options.grants.save({ ...grant, ownerId, tool: to });
      }
      if (moving.length > 0) options.onChanged?.(ownerId);
      return moving.length;
    },

    forgetServer: (ownerId, name) => forget(ownerId, { tool: name, kind: 'server' }),

    forgetAgent: (ownerId, slug) => forget(ownerId, { agent: slug }),

    forgetTool: (ownerId, tool) => forget(ownerId, { tool, kind: 'tool' }),
  };
}

export function directoryFromDatabase(
  db: Parameters<typeof grantStoreFrom>[0] & { getEnginePersonas(ownerId?: string): Promise<PersonaRecord[]> },
  extra: Pick<AgentDirectoryOptions, 'hidden' | 'onChanged'> = {},
): AgentDirectory {
  return createAgentDirectory({
    records: { list: (ownerId) => db.getEnginePersonas(ownerId) },
    grants: grantStoreFrom(db),
    ...extra,
  });
}

export function grantStoreFrom(db: {
  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void>;
  deleteToolGrantsFor(ownerId: string | undefined, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number>;
}): ToolGrantStore {
  return {
    list: (ownerId) => db.getToolGrants(ownerId),
    save: (grant) => db.saveToolGrant(grant),
    remove: (ownerId, agent, tool, kind) => db.deleteToolGrant(ownerId, agent, tool, kind),
    removeAll: (ownerId, of) => db.deleteToolGrantsFor(ownerId, of),
  };
}
