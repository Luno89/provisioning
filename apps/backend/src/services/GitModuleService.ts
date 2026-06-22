import { BaseService } from './BaseService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');

export interface OdooModule {
  id: string;
  name: string;
  summary: string;
  description: string;
  author: string;
  version: string;
  depends: string[];
}

/**
 * Service to manage and discover Odoo modules from a Git repository.
 * For now, it scans the local sibling directory.
 */
export class GitModuleService extends BaseService {
  private repoPath = path.join(PROJECT_ROOT, '../odoo-custom-modules');

  async listAvailableModules(): Promise<OdooModule[]> {
    try {
      const items = await fs.readdir(this.repoPath, { withFileTypes: true });
      const modules: OdooModule[] = [];

      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.')) {
          const manifestPath = path.join(this.repoPath, item.name, '__manifest__.py');
          try {
            await fs.access(manifestPath);
            const content = await fs.readFile(manifestPath, 'utf-8');
            
            // Basic parsing of Python dict manifest
            const module: OdooModule = {
              id: item.name,
              name: this.extractManifestValue(content, 'name') || item.name,
              summary: this.extractManifestValue(content, 'summary') || '',
              description: this.extractManifestValue(content, 'description') || '',
              author: this.extractManifestValue(content, 'author') || 'Unknown',
              version: this.extractManifestValue(content, 'version') || '1.0',
              depends: this.extractManifestList(content, 'depends') || []
            };
            modules.push(module);
          } catch {
            // Not an Odoo module or manifest unreadable
          }
        }
      }
      return modules;
    } catch (err: any) {
      this.logger.error(`Failed to list modules in ${this.repoPath}: ${err.message}`);
      return [];
    }
  }

  private extractManifestValue(content: string, key: string): string | null {
    const regex = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`, 'i');
    const match = content.match(regex);
    return match ? match[1] : null;
  }

  private extractManifestList(content: string, key: string): string[] | null {
    const regex = new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]+)\\]`, 'i');
    const match = content.match(regex);
    if (!match) return null;
    return match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(s => s);
  }
}
