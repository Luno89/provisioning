import type { Conversation } from '../../engine/lib/conversations.js';
import { channelIdFor } from '../../engine/lib/conversations.js';
import type { ProjectMetadata } from '../../platform/index.js';
import type { Tree } from '../lib/trees.js';

export interface ProjectChannelDeps {
  conversation: (ownerId: string, id: string) => Promise<Conversation | undefined>;
  save: (conversation: Conversation) => Promise<void>;
  bind: (ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }) => Promise<boolean>;
  trees: () => Promise<Tree[]>;
  saveProjectInfo: (project: Partial<ProjectMetadata> & { id: string }) => Promise<unknown>;
  now?: (() => string) | undefined;
}

export class ProjectChannelService {
  constructor(private readonly deps: ProjectChannelDeps) {}

  async ensure(project: Pick<ProjectMetadata, 'id' | 'name' | 'ownerId' | 'channelId'>): Promise<Conversation | undefined> {
    const ownerId = project.ownerId;
    if (!ownerId) return undefined;
    const id = project.channelId ?? channelIdFor(project.id);
    const tree = (await this.deps.trees()).find((entry) => entry.ownerId === ownerId && entry.projectIds?.[0] === project.id);
    const found = await this.deps.conversation(ownerId, id);
    if (found) {
      if (!project.channelId) await this.deps.saveProjectInfo({ id: project.id, channelId: id });
      if (tree && !found.treeId && await this.deps.bind(ownerId, id, { treeId: tree.id, projectId: project.id })) return { ...found, treeId: tree.id };
      return found;
    }
    const at = (this.deps.now ?? (() => new Date().toISOString()))();
    const channel: Conversation = {
      id,
      ownerId,
      title: project.name,
      kind: 'channel',
      projectId: project.id,
      ...(tree ? { treeId: tree.id } : {}),
      messages: [],
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.save(channel);
    if (!project.channelId) await this.deps.saveProjectInfo({ id: project.id, channelId: id });
    return channel;
  }
}
