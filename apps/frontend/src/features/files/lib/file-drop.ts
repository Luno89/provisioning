import type { FileScope, MessageAttachment } from '../types'

export interface PickedFile {
  path: string
  file: File
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (done: (file: File) => void, failed?: (err: unknown) => void) => void
  createReader?: () => { readEntries: (done: (entries: EntryLike[]) => void, failed?: (err: unknown) => void) => void }
}

const fileOf = (entry: EntryLike): Promise<File> => new Promise((resolve, reject) => entry.file!(resolve, reject))

const childrenOf = async (entry: EntryLike): Promise<EntryLike[]> => {
  const reader = entry.createReader!()
  const all: EntryLike[] = []
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

async function walk(entry: EntryLike, prefix: string): Promise<PickedFile[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) return [{ path, file: await fileOf(entry) }]
  if (!entry.isDirectory) return []
  const nested = await Promise.all((await childrenOf(entry)).map((child) => walk(child, path)))
  return nested.flat()
}

export async function droppedFiles(transfer: Pick<DataTransfer, 'items' | 'files'>): Promise<PickedFile[]> {
  const entries = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.() ?? null)
  if (entries.length && entries.every(Boolean)) return (await Promise.all(entries.map((entry) => walk(entry!, '')))).flat()
  return Array.from(transfer.files ?? []).map((file) => ({ path: file.name, file }))
}

export const pickedFiles = (files: FileList | readonly File[] | null): PickedFile[] =>
  Array.from(files ?? []).map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }))

export const joinPath = (...parts: string[]): string => parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')

export function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export const storyFolder = (leafId: string): string => `stories/${leafId}`

export const attachmentName = (name: string): string => {
  const clean = name.replace(/[/\\]/g, '_').trim()
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

export interface AttachmentPlace {
  scope: Exclude<FileScope, { kind: 'hub' | 'mine' }>
  path: string
}

export const numberedName = (name: string, n: number): string => {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

export const attachmentPlace = (conversationId: string, projectId: string | undefined, name: string, n = 1): AttachmentPlace =>
  projectId
    ? { scope: { kind: 'project', projectId }, path: joinPath('chats', conversationId, numberedName(attachmentName(name), n)) }
    : { scope: { kind: 'conversation', conversationId }, path: numberedName(attachmentName(name), n) }

export const sentAttachmentPlace = (
  attachment: Pick<MessageAttachment, 'fileId' | 'name' | 'project'>,
  conversationId: string | undefined,
  hubProjectId?: string | undefined,
): { scope: FileScope; path: string } | undefined => {
  if (!attachment.fileId || !conversationId) return undefined
  const place = attachmentPlace(conversationId, attachment.project?.id, attachment.name)
  if (hubProjectId === undefined) return place
  return place.scope.kind === 'project' ? { scope: { kind: 'hub', projectId: hubProjectId }, path: place.path } : undefined
}

export interface SentAttachment {
  fileId: string
  name: string
  size?: number
  type?: string
  projectId?: string
}

export const sentAttachment = (attachment: MessageAttachment): SentAttachment[] =>
  attachment.fileId
    ? [{
        fileId: attachment.fileId,
        name: attachment.name,
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        ...(attachment.type ? { type: attachment.type } : {}),
        ...(attachment.project ? { projectId: attachment.project.id } : {}),
      }]
    : []
