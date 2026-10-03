import { checkProcedure, readProcedure, type EngineExtension, type GroupDefinition, type NodeCatalogue, type Procedure } from '@koala/agent-engine/procedure';
import type { Database } from '../lib/db-interface.js';
import { INSTALLED_EXTENSIONS, platformCatalogue, platformGroups } from '../extensions/installed.js';
import type { ProcedureSource } from '../lib/procedure-source.js';
import { ALWAYS_ON, enabledExtensions, hiddenBy, switchProblem, withSwitch, type HiddenVocabulary } from '../lib/extension-settings.js';
import {
  authoredGroups,
  authoredVocabulary,
  extensionProblem,
  groupProblems,
  latestOf,
  onVersion,
  publishedId,
  usesOperation,
  type AuthoredExtension,
} from '../lib/authored-extensions.js';

export type ExtensionOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

export interface ExtensionState {
  extension: EngineExtension;
  enabled: boolean;
  alwaysOn: boolean;
  authored: boolean;
  latest?: string[] | undefined;
}

export interface OwnedItems {
  agents: ReadonlySet<string>;
  tools: ReadonlySet<string>;
  procedures: ReadonlySet<string>;
}

const NAME = /^[a-z][a-z0-9-]*$/;

function asExtension(authored: AuthoredExtension): EngineExtension {
  const vocabulary = authoredVocabulary(authored);
  return {
    id: vocabulary.id,
    title: vocabulary.title,
    describe: vocabulary.describe,
    version: vocabulary.version,
    groups: vocabulary.groups,
    tools: vocabulary.tools as never,
    personas: vocabulary.personas as never,
    procedures: vocabulary.procedures.map((id) => ({ id })) as never,
  };
}

export class ExtensionService {
  constructor(private readonly deps: {
    store: Pick<Database, 'getExtensionSettings' | 'saveExtensionSettings' | 'getAuthoredExtensions' | 'saveAuthoredExtension' | 'deleteAuthoredExtension' | 'getProcedures' | 'saveProcedure'>;
    installed: readonly EngineExtension[];
    catalogue?: (() => NodeCatalogue) | undefined;
    sharedGroups?: (() => GroupDefinition[]) | undefined;
    owned?: ((ownerId: string) => Promise<OwnedItems>) | undefined;
    now?: (() => string) | undefined;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async everything(ownerId: string): Promise<{ all: EngineExtension[]; authored: AuthoredExtension[] }> {
    const authored = await this.deps.store.getAuthoredExtensions(ownerId);
    return { all: [...this.deps.installed, ...authored.map(asExtension)], authored };
  }

  async list(ownerId: string): Promise<ExtensionState[]> {
    const { all, authored } = await this.everything(ownerId);
    const on = new Set(enabledExtensions(all, await this.deps.store.getExtensionSettings(ownerId)).map((extension) => extension.id));
    return all.map((extension) => {
      const own = authored.find((entry) => entry.id === extension.id);
      return {
        extension,
        enabled: on.has(extension.id),
        alwaysOn: ALWAYS_ON.includes(extension.id),
        authored: Boolean(own),
        ...(own ? { latest: own.operations.map((operation) => latestOf(operation).group.id) } : {}),
      };
    });
  }

  async enabled(ownerId: string): Promise<EngineExtension[]> {
    return enabledExtensions(this.deps.installed, await this.deps.store.getExtensionSettings(ownerId));
  }

  async hidden(ownerId: string): Promise<HiddenVocabulary> {
    const { all } = await this.everything(ownerId);
    return hiddenBy(all, await this.deps.store.getExtensionSettings(ownerId));
  }

  async groups(ownerId: string): Promise<GroupDefinition[]> {
    return (await this.deps.store.getAuthoredExtensions(ownerId)).flatMap(authoredGroups);
  }

  async setEnabled(ownerId: string, id: string, enabled: boolean): Promise<ExtensionOutcome<ExtensionState[]>> {
    const { all } = await this.everything(ownerId);
    const settings = await this.deps.store.getExtensionSettings(ownerId);
    const problem = switchProblem(all, settings?.disabled ?? [], id, enabled);
    if (problem) return { ok: false, status: all.some((extension) => extension.id === id) ? 409 : 404, error: problem };
    await this.deps.store.saveExtensionSettings(withSwitch(settings, ownerId, id, enabled, this.now()));
    return { ok: true, value: await this.list(ownerId) };
  }

  async create(ownerId: string, input: { id: string; title: string; describe?: string | undefined }): Promise<ExtensionOutcome<ExtensionState[]>> {
    const { all } = await this.everything(ownerId);
    const candidate = { id: String(input.id ?? '').trim(), title: String(input.title ?? '').trim() };
    const problem = extensionProblem(candidate, new Set(all.map((extension) => extension.id)));
    if (problem) return { ok: false, status: 400, error: problem };
    const now = this.now();
    await this.deps.store.saveAuthoredExtension({
      ownerId, ...candidate, describe: String(input.describe ?? '').trim(), operations: [], tools: [], personas: [], procedures: [], createdAt: now, updatedAt: now,
    });
    return { ok: true, value: await this.list(ownerId) };
  }

  async update(ownerId: string, id: string, input: { title?: string; describe?: string; tools?: string[]; personas?: string[]; procedures?: string[] }): Promise<ExtensionOutcome<ExtensionState[]>> {
    const found = await this.authored(ownerId, id);
    if (!found) return { ok: false, status: 404, error: `you have no extension called "${id}"` };
    const owned = await this.deps.owned?.(ownerId);
    const pick = (asked: unknown, mine: ReadonlySet<string> | undefined, what: string): string[] | string => {
      if (asked === undefined) return '';
      if (!Array.isArray(asked) || asked.some((entry) => typeof entry !== 'string')) return `${what} has to be a list of names`;
      const strange = (asked as string[]).filter((entry) => mine && !mine.has(entry));
      return strange.length > 0 ? `${strange.join(', ')} ${strange.length === 1 ? 'is' : 'are'} not ${what} of your own` : [...new Set(asked as string[])].sort();
    };
    const tools = pick(input.tools, owned?.tools, 'tools');
    const personas = pick(input.personas, owned?.agents, 'agents');
    const procedures = pick(input.procedures, owned?.procedures, 'procedures');
    for (const picked of [tools, personas, procedures]) if (typeof picked === 'string' && picked) return { ok: false, status: 400, error: picked };
    if (input.title !== undefined && !String(input.title).trim()) return { ok: false, status: 400, error: 'an extension needs a title' };
    await this.deps.store.saveAuthoredExtension({
      ...found,
      ...(input.title !== undefined ? { title: String(input.title).trim() } : {}),
      ...(input.describe !== undefined ? { describe: String(input.describe).trim() } : {}),
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(Array.isArray(personas) ? { personas } : {}),
      ...(Array.isArray(procedures) ? { procedures } : {}),
      updatedAt: this.now(),
    });
    return { ok: true, value: await this.list(ownerId) };
  }

  async publish(ownerId: string, id: string, name: string, group: GroupDefinition): Promise<ExtensionOutcome<{ id: string; version: number; moved: string[] }>> {
    const found = await this.authored(ownerId, id);
    if (!found) return { ok: false, status: 404, error: `you have no extension called "${id}"` };
    if (!NAME.test(name)) return { ok: false, status: 400, error: 'an operation\'s name is lower-case words joined by dashes' };

    const existing = found.operations.find((operation) => operation.name === name);
    const version = existing ? latestOf(existing).version + 1 : 1;
    const published: GroupDefinition = { ...group, id: publishedId(id, name, version) };

    const groups = [...(this.deps.sharedGroups?.() ?? []), ...await this.groups(ownerId), published];
    const catalogue = this.deps.catalogue?.();
    if (catalogue) {
      const problems = groupProblems(published, { catalogue, groups });
      if (problems.length > 0) return { ok: false, status: 400, error: `the group does not check: ${problems.map((problem) => problem.message).join('; ')}` };
    }

    const now = this.now();
    const moved: { source: ProcedureSource; procedure: Procedure }[] = [];
    const broken: string[] = [];
    for (const source of await this.deps.store.getProcedures(ownerId)) {
      if (source.ownerId !== ownerId) continue;
      const read = readProcedure(source.source);
      if (!read.ok || !usesOperation(read.procedure, id, name)) continue;
      const bumped = onVersion(read.procedure, id, name, version);
      if (catalogue && checkProcedure(bumped, { catalogue, groups }).some((problem) => problem.severity === 'error')) broken.push(read.procedure.id);
      else moved.push({ source, procedure: bumped });
    }
    if (broken.length > 0) {
      return { ok: false, status: 409, error: `this version would break ${broken.join(', ')}, which ${broken.length === 1 ? 'uses' : 'use'} the operation — keep the sockets and exits they wire, or change them first` };
    }

    const operations = existing
      ? found.operations.map((operation) => (operation.name === name ? { ...operation, versions: [...operation.versions, { version, group: published, savedAt: now }] } : operation))
      : [...found.operations, { name, versions: [{ version, group: published, savedAt: now }] }];
    await this.deps.store.saveAuthoredExtension({ ...found, operations, updatedAt: now });
    for (const { source, procedure } of moved) {
      await this.deps.store.saveProcedure({ ...source, source: JSON.stringify(procedure, null, 2), updatedAt: now });
    }
    return { ok: true, value: { id: published.id, version, moved: moved.map(({ procedure }) => procedure.id) } };
  }

  async removeOperation(ownerId: string, id: string, name: string): Promise<ExtensionOutcome<ExtensionState[]>> {
    const found = await this.authored(ownerId, id);
    if (!found) return { ok: false, status: 404, error: `you have no extension called "${id}"` };
    if (!found.operations.some((operation) => operation.name === name)) return { ok: false, status: 404, error: `${found.title} has no operation called "${name}"` };
    const users = await this.usersOf(ownerId, id, name);
    if (users.length > 0) return { ok: false, status: 409, error: `${users.join(', ')} still ${users.length === 1 ? 'uses' : 'use'} it` };
    await this.deps.store.saveAuthoredExtension({ ...found, operations: found.operations.filter((operation) => operation.name !== name), updatedAt: this.now() });
    return { ok: true, value: await this.list(ownerId) };
  }

  async remove(ownerId: string, id: string): Promise<ExtensionOutcome<ExtensionState[]>> {
    const found = await this.authored(ownerId, id);
    if (!found) return { ok: false, status: 404, error: `you have no extension called "${id}"` };
    const users = (await Promise.all(found.operations.map((operation) => this.usersOf(ownerId, id, operation.name)))).flat();
    if (users.length > 0) return { ok: false, status: 409, error: `${[...new Set(users)].join(', ')} still ${users.length === 1 ? 'uses' : 'use'} its operations` };
    await this.deps.store.deleteAuthoredExtension(ownerId, id);
    return { ok: true, value: await this.list(ownerId) };
  }

  private async authored(ownerId: string, id: string): Promise<AuthoredExtension | undefined> {
    return (await this.deps.store.getAuthoredExtensions(ownerId)).find((extension) => extension.id === id);
  }

  private async usersOf(ownerId: string, id: string, name: string): Promise<string[]> {
    const users: string[] = [];
    for (const source of await this.deps.store.getProcedures(ownerId)) {
      if (source.ownerId !== ownerId) continue;
      const read = readProcedure(source.source);
      if (read.ok && usesOperation(read.procedure, id, name)) users.push(read.procedure.id);
    }
    return users;
  }
}

export function extensionServiceFor(db: Database): ExtensionService {
  return new ExtensionService({
    store: db,
    installed: INSTALLED_EXTENSIONS,
    catalogue: platformCatalogue,
    sharedGroups: platformGroups,
    owned: async (ownerId: string) => ({
      agents: new Set((await db.getEnginePersonas(ownerId)).filter((row) => row.ownerId === ownerId).map((row) => row.slug)),
      tools: new Set((await db.getEngineTools(ownerId)).filter((row) => row.ownerId === ownerId).map((row) => row.name)),
      procedures: new Set((await db.getProcedures(ownerId)).filter((row) => row.ownerId === ownerId).map((row) => row.id)),
    }),
  });
}
