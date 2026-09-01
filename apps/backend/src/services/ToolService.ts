import { BaseService } from './BaseService.js';
import { withBuiltIns } from '../lib/ownership.js';
import { schemasFor, effectOf, parametersOf, type ToolSchema } from '../lib/tool-catalogue.js';
import type { ToolRepositoryItem } from '../lib/tool-seeds.js';

export class ToolService extends BaseService {
  async list(userId: string): Promise<ToolRepositoryItem[]> {
    return withBuiltIns(await this.db.getTools(), userId, (t) => t.name);
  }

  async schemas(userId: string, names?: readonly string[]): Promise<ToolSchema[]> {
    const rows = await this.list(userId);
    return names ? schemasFor(rows, names) : rows.map((r) => ({
      type: 'function' as const,
      function: { name: r.name, description: r.description, parameters: r.parameters ?? { type: 'object', properties: {} } },
    }));
  }

  async effectOf(userId: string, name: string) {
    return effectOf(await this.list(userId), name);
  }

  async parametersOf(userId: string, name: string) {
    return parametersOf(await this.list(userId), name);
  }
}
