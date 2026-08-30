import { BaseService } from './BaseService.js';
import { withBuiltIns } from '../lib/ownership.js';
import type { ToolRepositoryItem } from '../lib/tool-seeds.js';

export class ToolService extends BaseService {
  async list(userId: string): Promise<ToolRepositoryItem[]> {
    return withBuiltIns(await this.db.getTools(), userId, (t) => t.name);
  }
}
