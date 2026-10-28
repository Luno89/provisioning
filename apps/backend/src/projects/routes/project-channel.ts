import { Router, type Request, type Response } from 'express';
import { asyncRoute, type ProjectMetadata, principalFrom, type Principal } from '../../platform/index.js';
import type { Conversation } from '../../engine/index.js';
import type { ProjectChannelService } from '../services/ProjectChannelService.js';

export interface ProjectChannelRouterDeps {
  channels: Pick<ProjectChannelService, 'ensure'>;
  conversations: (ownerId: string) => Promise<Conversation[]>;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined | null>;
}

export function projectChannelRouter(deps: ProjectChannelRouterDeps): Router {
  const router = Router();

  router.get('/:id/channel', asyncRoute(async (req: Request, res: Response) => {
    const project = await deps.getOwnedProject(String(req.params.id), principalFrom(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const channel = await deps.channels.ensure(project);
    if (!channel) return res.status(409).json({ error: 'The project has no owner, so it has no channel' });
    const threads = (await deps.conversations(channel.ownerId))
      .filter((conversation) => conversation.id !== channel.id && conversation.kind !== 'item' && (conversation.projectId === project.id || (channel.treeId && conversation.treeId === channel.treeId)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .map((conversation) => ({ id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, messageCount: conversation.messages.length }));
    return res.json({ channel: { id: channel.id, title: channel.title }, threads });
  }));

  return router;
}
