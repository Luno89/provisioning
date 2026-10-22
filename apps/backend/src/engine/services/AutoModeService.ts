import type { Database } from '../../platform/lib/db-interface.js';
import { runsUnasked, switchedOn, withAgent } from '../lib/auto-mode.js';

export type AutoModeStore = Pick<Database, 'engine' | 'projects'>;

export type AutoModeOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

export interface RunAskingArgs {
  ownerId: string;
  agentSlug: string;
  treeId?: string | undefined;
  conversationId?: string | undefined;
}

export class AutoModeService {
  constructor(private readonly deps: {
    store: AutoModeStore;
    agentExists: (ownerId: string, agentSlug: string) => Promise<boolean>;
    now?: () => string;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async agents(ownerId: string): Promise<string[]> {
    return (await this.deps.store.engine.getAutoModeSettings(ownerId))?.agents ?? [];
  }

  async setAgent(ownerId: string, agentSlug: string, body: unknown): Promise<AutoModeOutcome<{ agents: string[] }>> {
    const on = switchedOn(body);
    if (typeof on === 'string') return { ok: false, status: 400, error: on };
    if (on && !(await this.deps.agentExists(ownerId, agentSlug))) return { ok: false, status: 404, error: 'Agent not found' };
    const settings = withAgent(await this.deps.store.engine.getAutoModeSettings(ownerId), ownerId, agentSlug, on, this.now());
    await this.deps.store.engine.saveAutoModeSettings(settings);
    return { ok: true, value: { agents: settings.agents } };
  }

  async setTree(ownerId: string, treeId: string, body: unknown): Promise<AutoModeOutcome<{ autoMode: boolean }>> {
    const on = switchedOn(body);
    if (typeof on === 'string') return { ok: false, status: 400, error: on };
    const tree = (await this.deps.store.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    const { autoMode: _was, ...rest } = tree;
    await this.deps.store.projects.saveTree({ ...rest, ...(on ? { autoMode: true } : {}), updatedAt: this.now() });
    return { ok: true, value: { autoMode: on } };
  }

  async setConversation(ownerId: string, conversationId: string, body: unknown): Promise<AutoModeOutcome<{ autoMode: boolean }>> {
    const on = switchedOn(body);
    if (typeof on === 'string') return { ok: false, status: 400, error: on };
    if (!(await this.deps.store.engine.setConversationAutoMode(ownerId, conversationId, on))) return { ok: false, status: 404, error: 'Conversation not found' };
    return { ok: true, value: { autoMode: on } };
  }

  async unasked({ ownerId, agentSlug, treeId, conversationId }: RunAskingArgs): Promise<boolean> {
    const settings = await this.deps.store.engine.getAutoModeSettings(ownerId);
    const conversation = conversationId ? await this.deps.store.engine.getConversation(ownerId, conversationId) : undefined;
    const boundTree = treeId ?? conversation?.treeId;
    const tree = boundTree ? (await this.deps.store.projects.getTrees()).find((entry) => entry.id === boundTree && entry.ownerId === ownerId) : undefined;
    return runsUnasked({ agentSlug, settings, tree, conversation });
  }
}
