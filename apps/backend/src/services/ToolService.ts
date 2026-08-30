import { BaseService } from './BaseService.js';
import { withBuiltIns } from '../lib/ownership.js';
import { formatToolRepoForOpenAI } from '../lib/tool-repository.js';
import type { ToolRepositoryItem } from '../lib/tool-seeds.js';

export class ToolService extends BaseService {
  async list(userId: string): Promise<ToolRepositoryItem[]> {
    return withBuiltIns(await this.db.getTools(), userId, (t) => t.name);
  }

  /**
   * The catalogue as OpenAI function schemas, for a run's tool list.
   *
   * The leaf loop built these from `TOOL_REPOSITORY`, so a leaf was offered the compiled-in
   * descriptions whatever the database said — and a user's edit reached the chat but never a run.
   */
  async schemas(userId: string) {
    return formatToolRepoForOpenAI(await this.list(userId));
  }
}
