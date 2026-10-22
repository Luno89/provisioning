import type { StoredFile } from '../types'

export type SortBy = 'name' | 'size' | 'modified'

export function sortEntries(entries: readonly StoredFile[], by: SortBy, descending = false): StoredFile[] {
  const sign = descending ? -1 : 1
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    if (by === 'size') return sign * (((a.size ?? 0) - (b.size ?? 0)) || a.name.localeCompare(b.name))
    if (by === 'modified') return sign * ((a.modified ?? '').localeCompare(b.modified ?? '') || a.name.localeCompare(b.name))
    return sign * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none'

const BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', svg: 'image',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', tsv: 'text', json: 'text', yaml: 'text', yml: 'text', xml: 'text',
  log: 'text', ini: 'text', toml: 'text', conf: 'text', sql: 'text', html: 'text', htm: 'text', css: 'text', js: 'text', ts: 'text', py: 'text', sh: 'text',
}

export function previewKind(name: string): PreviewKind {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return name.includes('.') ? BY_EXTENSION[extension] ?? 'none' : 'none'
}

export const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

export function moveInto(path: string, folder: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const target = folder ? `${folder}/${name}` : name
  if (target === path || folder === path || folder.startsWith(`${path}/`)) return undefined
  return target
}

export const MOVE_TYPE = 'application/x-koala-stored-paths'

export const expiresText = (expiresAt: string, now: Date): string => {
  const hours = Math.round((Date.parse(expiresAt) - now.getTime()) / 3_600_000)
  if (hours <= 0) return 'expired'
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} left`
  return `${Math.round(hours / 24)} days left`
}
