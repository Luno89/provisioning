import { BaseService } from './BaseService.js';
import { withBuiltIns } from '../lib/ownership.js';
import { capableImage, imageForLanguage, isWorkspaceLanguage } from '../lib/workspace-image-catalogue.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';

export class WorkspaceImageService extends BaseService {
  async list(userId: string): Promise<WorkspaceImageSpec[]> {
    return withBuiltIns(await this.db.getWorkspaceImages(), userId, (i) => i.id);
  }

  async imageFor(userId: string, language?: string): Promise<string> {
    return imageForLanguage(await this.list(userId), language);
  }

  async capableImage(userId: string, language: string | undefined, requires: readonly string[] = []): Promise<string> {
    return capableImage(await this.list(userId), language, requires);
  }

  async isLanguage(userId: string, value: unknown): Promise<boolean> {
    return isWorkspaceLanguage(await this.list(userId), value);
  }
}
