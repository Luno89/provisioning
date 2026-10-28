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

export function attachmentPath(inProject: boolean, name: string, now: Date): string {
  const stamp = now.toISOString()
  const clean = name.replace(/[/\\]/g, '_')
  return joinPath(inProject ? 'attachments' : 'chats', stamp.slice(0, 10), `${stamp.slice(11, 19).replace(/:/g, '')}-${clean}`)
}

export function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export interface SentAttachment {
  name: string
  path: string
  size?: number
  type?: string
  projectId?: string
}

export const sentAttachment = (attachment: { name: string; path: string; size?: number | undefined; type?: string | undefined; project?: { id: string } | undefined }): SentAttachment => ({
  name: attachment.name,
  path: attachment.path,
  ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  ...(attachment.type ? { type: attachment.type } : {}),
  ...(attachment.project ? { projectId: attachment.project.id } : {}),
})

export const storyFolder = (leafId: string): string => `stories/${leafId}`
