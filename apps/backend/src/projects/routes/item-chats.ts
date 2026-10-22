import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { ChatItem } from '../../engine/lib/conversations.js';
import type { ItemChatService } from '../services/ItemChatService.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const itemOf = (req: Request): ChatItem | undefined => {
  const kind = String(req.params.kind);
  const id = String(req.params.id);
  return kind === 'story' ? { kind, leafId: id } : kind === 'feature' ? { kind, branchId: id } : undefined;
};

export interface ItemChatsRouterDeps {
  items: Pick<ItemChatService, 'ensure'>;
}

export function itemChatsRouter(deps: ItemChatsRouterDeps): Router {
  const router = Router();

  router.post('/:kind/:id/chat', asyncRoute(async (req: Request, res: Response) => {
    const item = itemOf(req);
    if (!item) return res.status(404).json({ error: 'Only a story or a feature has its own chat' });
    const chat = await deps.items.ensure(userOf(req).id, item);
    if (!chat) return res.status(404).json({ error: `No such ${item.kind}` });
    return res.json({ id: chat.id, title: chat.title });
  }));

  return router;
}
