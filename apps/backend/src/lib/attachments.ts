import { cleanPath } from './file-places.js';

export interface MessageAttachment {
  name: string;
  path: string;
  size?: number | undefined;
  type?: string | undefined;
  project?: { id: string; name: string } | undefined;
}

export const MAX_ATTACHMENTS = 20;

export type AttachmentsReading = { ok: true; attachments: MessageAttachment[] } | { ok: false; why: string };

const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export function readAttachments(value: unknown, projects: readonly { id: string; name: string }[]): AttachmentsReading {
  if (value === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, why: 'attachments must be a list' };
  if (value.length > MAX_ATTACHMENTS) return { ok: false, why: `at most ${MAX_ATTACHMENTS} files can be attached to one message` };
  const attachments: MessageAttachment[] = [];
  for (const entry of value as Record<string, unknown>[]) {
    const path = cleanPath(typeof entry?.path === 'string' ? entry.path : '');
    if (!path.ok) return { ok: false, why: path.why };
    const projectId = typeof entry.projectId === 'string' ? entry.projectId : undefined;
    const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;
    if (projectId && !project) return { ok: false, why: `${projectId} is not one of your projects` };
    attachments.push({
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.path.split('/').pop()!,
      path: path.path,
      ...(typeof entry.size === 'number' && entry.size >= 0 ? { size: entry.size } : {}),
      ...(typeof entry.type === 'string' && entry.type ? { type: entry.type } : {}),
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
    });
  }
  return { ok: true, attachments };
}

export function attachmentsText(attachments: readonly MessageAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((file) => {
    const what = [file.type, file.size !== undefined ? sizeText(file.size) : undefined].filter(Boolean).join(', ');
    const where = file.project ? `in the project ${file.project.name}'s files` : 'in the person\'s own files';
    return `- ${file.name}${what ? ` (${what})` : ''}, ${where} at ${file.path}`;
  });
  return `\n\nAttached to this message (read each with read_stored_file, naming the project and the path):\n${lines.join('\n')}`;
}
