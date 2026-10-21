import { Readable } from 'node:stream';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { cleanPath } from '../../lib/file-places.js';
import type { ProjectMetadata } from '../../lib/types.js';
import type { FileScope, FileService } from '../../services/FileService.js';
import { LIST_FILES, READ_STORED_FILE, REMOVE_STORED_FILE, STORE_FILE } from './catalogue.js';

export const READ_LIMIT = 100_000;

export interface FilesToolDeps {
  files: Pick<FileService, 'list' | 'download' | 'upload' | 'remove'>;
  projects: (ownerId: string) => Promise<ProjectMetadata[]>;
  projectOfTree: (ownerId: string, treeId: string) => Promise<string | undefined>;
  projectOfConversation: (ownerId: string, conversationId: string) => Promise<string | undefined>;
}

type Caller = Parameters<ToolHandler>[0]['caller'];

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|csv|x-sh|sql))/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|ts|py|sql|log|ini|toml|conf|sh|svg)$/i;

const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export function createFilesTools(deps: FilesToolDeps | undefined): Record<string, ToolHandler> {
  if (!deps) {
    const unreachable = async (): Promise<ToolOutcome> => refuse('the person\'s file servers cannot be reached from here');
    return { [LIST_FILES]: unreachable, [READ_STORED_FILE]: unreachable, [STORE_FILE]: unreachable, [REMOVE_STORED_FILE]: unreachable };
  }
  const scopeOf = async (args: Record<string, unknown>, caller: Caller): Promise<{ scope: FileScope; named: string } | { refused: ToolOutcome }> => {
    if (!caller.ownerId) return { refused: refuse('this run has no owner whose files could be reached') };
    const projects = await deps.projects(caller.ownerId);
    const wanted = text(args.project);
    if (wanted) {
      const project = projects.find((entry) => entry.id === wanted) ?? projects.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
      if (!project) return { refused: refuse(`no project of yours is called ${wanted}; there are ${projects.map((entry) => entry.name).join(', ') || 'none'}`) };
      return { scope: { kind: 'project', project }, named: project.name };
    }
    const id = caller.projectId
      ?? (caller.treeId ? await deps.projectOfTree(caller.ownerId, caller.treeId) : undefined)
      ?? (caller.conversationId ? await deps.projectOfConversation(caller.ownerId, caller.conversationId) : undefined);
    const project = id ? projects.find((entry) => entry.id === id) : undefined;
    return project ? { scope: { kind: 'project', project }, named: project.name } : { scope: { kind: 'mine' }, named: 'your own files' };
  };

  const pathOf = (value: unknown, allowRoot = false): { path: string } | { refused: ToolOutcome } => {
    const cleaned = cleanPath(typeof value === 'string' ? value : '', { allowRoot });
    return cleaned.ok ? { path: cleaned.path } : { refused: refuse(cleaned.why) };
  };

  return {
    async [LIST_FILES]({ parsed, caller }) {
      const args = (parsed ?? {}) as Record<string, unknown>;
      const where = await scopeOf(args, caller);
      if ('refused' in where) return where.refused;
      const dir = pathOf(args.folder, true);
      if ('refused' in dir) return dir.refused;
      const listed = await deps.files.list(caller.ownerId!, where.scope, dir.path);
      if (!listed.ok) return refuse(listed.why);
      const lines = listed.value.map((entry) => (entry.type === 'dir' ? `${entry.path}/` : `${entry.path} (${sizeText(entry.size ?? 0)}${entry.modified ? `, changed ${entry.modified}` : ''})`));
      const content = lines.length ? `${where.named}, ${dir.path || 'top'}:\n${lines.join('\n')}` : `${where.named} has nothing in ${dir.path || 'its files'} yet.`;
      return { ok: true, digest: `${lines.length} in ${dir.path || 'the top'}`, content };
    },

    async [READ_STORED_FILE]({ parsed, caller }) {
      const args = (parsed ?? {}) as Record<string, unknown>;
      const where = await scopeOf(args, caller);
      if ('refused' in where) return where.refused;
      const path = pathOf(args.path);
      if ('refused' in path) return path.refused;
      const found = await deps.files.download(caller.ownerId!, where.scope, path.path);
      if (!found.ok) return refuse(found.why);
      const readable = TEXTUAL.test(found.value.contentType) || TEXT_NAMES.test(path.path);
      if (!readable) {
        found.value.stream.destroy();
        const said = `${path.path} is ${found.value.contentType}${found.value.size !== undefined ? `, ${sizeText(found.value.size)}` : ''}; it is not text, so it is described rather than read.`;
        return { ok: true, digest: said, content: said };
      }
      const parts: Buffer[] = [];
      let length = 0;
      for await (const part of found.value.stream) {
        parts.push(Buffer.from(part as Buffer));
        length += (part as Buffer).length;
        if (length > READ_LIMIT * 4) break;
      }
      found.value.stream.destroy();
      const whole = Buffer.concat(parts).toString('utf8');
      const content = whole.length > READ_LIMIT ? `${whole.slice(0, READ_LIMIT)}\n…(the rest of ${path.path} is longer than ${READ_LIMIT} characters)` : whole;
      return { ok: true, digest: `read ${path.path}`, content };
    },

    async [STORE_FILE]({ parsed, caller }) {
      const args = (parsed ?? {}) as Record<string, unknown>;
      const where = await scopeOf(args, caller);
      if ('refused' in where) return where.refused;
      const path = pathOf(args.path);
      if ('refused' in path) return path.refused;
      if (typeof args.content !== 'string') return refuse('give the text to store as content');
      const bytes = Buffer.from(args.content, 'utf8');
      const stored = await deps.files.upload(caller.ownerId!, where.scope, path.path, Readable.from([bytes]), bytes.length, TEXT_NAMES.test(path.path) && /\.md$/i.test(path.path) ? 'text/markdown' : 'text/plain; charset=utf-8');
      if (!stored.ok) return refuse(stored.why);
      return { ok: true, digest: `stored ${path.path}`, content: `Stored ${path.path} in ${where.named} (${sizeText(bytes.length)}).` };
    },

    async [REMOVE_STORED_FILE]({ parsed, caller }) {
      const args = (parsed ?? {}) as Record<string, unknown>;
      const where = await scopeOf(args, caller);
      if ('refused' in where) return where.refused;
      const path = pathOf(args.path);
      if ('refused' in path) return path.refused;
      const removed = await deps.files.remove(caller.ownerId!, where.scope, path.path);
      if (!removed.ok) return refuse(removed.why);
      return { ok: true, digest: `removed ${path.path}`, content: `Removed ${path.path} from ${where.named}.` };
    },
  };
}
