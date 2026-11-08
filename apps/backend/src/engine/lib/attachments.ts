import { sizeText } from '../../files/lib/file-room.js';

export interface MessageAttachment {
  fileId: string;
  name: string;
  size?: number | undefined;
  type?: string | undefined;
  project?: { id: string; name: string } | undefined;
}

export interface AttachableFile {
  id: string;
  path: string;
  size: number;
  contentType: string;
  projectId?: string | undefined;
}

export type FindAttachable = (fileId: string) => Promise<AttachableFile | undefined>;

export const MAX_ATTACHMENTS = 20;

export type AttachmentsReading = { ok: true; attachments: MessageAttachment[] } | { ok: false; why: string };


const fileIdOf = (entry: unknown): string | undefined => {
  const id = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).fileId : undefined;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
};

export async function readAttachments(value: unknown, find: FindAttachable | undefined, projects: readonly { id: string; name: string }[]): Promise<AttachmentsReading> {
  if (value === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, why: 'attachments must be a list' };
  if (value.length === 0) return { ok: true, attachments: [] };
  if (value.length > MAX_ATTACHMENTS) return { ok: false, why: `at most ${MAX_ATTACHMENTS} files can be attached to one message` };
  if (!find) return { ok: false, why: 'files cannot be attached to a message here' };
  const attachments: MessageAttachment[] = [];
  for (const entry of value as unknown[]) {
    const fileId = fileIdOf(entry);
    if (!fileId) return { ok: false, why: 'each attachment names the file it attaches by its fileId' };
    const file = await find(fileId);
    if (!file) return { ok: false, why: `${fileId} is not a file you keep` };
    const project = file.projectId ? projects.find((candidate) => candidate.id === file.projectId) : undefined;
    if (file.projectId && !project) return { ok: false, why: `${fileId} is kept in a project that is not yours` };
    attachments.push({
      fileId: file.id,
      name: file.path.split('/').pop()!,
      size: file.size,
      type: file.contentType,
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
    });
  }
  return { ok: true, attachments };
}

export function attachmentsText(attachments: readonly MessageAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((file) => {
    const what = [file.type, file.size !== undefined ? sizeText(file.size) : undefined].filter(Boolean).join(', ');
    const where = file.project ? `in the project ${file.project.name}'s files` : 'in the person\'s files';
    return `- ${file.name}${what ? ` (${what})` : ''}, ${where}, file id ${file.fileId}`;
  });
  return `\n\nAttached to this message (read each with read_stored_file, giving its file id as fileId):\n${lines.join('\n')}`;
}

export const keptAttachment = (entry: Partial<MessageAttachment>): boolean => typeof entry.fileId === 'string' && entry.fileId !== '';

export function withoutUnkeptAttachments<M extends { attachments?: MessageAttachment[] | undefined }>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const kept = messages.map((message) => {
    if (!message.attachments || message.attachments.every(keptAttachment)) return message;
    changed = true;
    const attachments = message.attachments.filter(keptAttachment);
    const { attachments: _was, ...rest } = message;
    return (attachments.length > 0 ? { ...rest, attachments } : rest) as M;
  });
  return changed ? kept : undefined;
}
