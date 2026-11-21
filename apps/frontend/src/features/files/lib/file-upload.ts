import type { FileShare, StoredFile } from '../types'
import { joinPath, sizeText, type PickedFile } from './file-drop'
import { parentOf } from './file-browser'

export type ListFolder = (dir: string) => Promise<readonly StoredFile[]>

export interface Upload {
  dir: string
  picked: readonly PickedFile[]
}

export const targetPaths = ({ dir, picked }: Upload): string[] => picked.map((one) => joinPath(dir, one.path))

export const totalSize = (picked: readonly PickedFile[]): number => picked.reduce((sum, one) => sum + one.file.size, 0)

export type UploadWay = 'put' | 'drop'

export const uploadWay = (count: number): UploadWay => (count <= 1 ? 'put' : 'drop')

const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

export async function takenPaths(list: ListFolder, targets: readonly string[]): Promise<string[]> {
  const wanted = new Set(targets)
  const folders = new Set(targets.flatMap(ancestorsOf))
  const taken: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const entries = await list(dir)
    for (const entry of entries) if (entry.type === 'file' && wanted.has(entry.path)) taken.push(entry.path)
    const inside = entries.filter((entry) => entry.type === 'dir' && folders.has(entry.path))
    await Promise.all(inside.map((entry) => visit(entry.path)))
  }
  if (targets.length) await visit('')
  return targets.filter((path) => taken.includes(path))
}

export async function fileIdsUnder(list: ListFolder, paths: readonly string[]): Promise<string[]> {
  const ids = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    const entries = await list(dir)
    for (const entry of entries) if (entry.type === 'file' && entry.id) ids.add(entry.id)
    await Promise.all(entries.filter((entry) => entry.type === 'dir').map((entry) => walk(entry.path)))
  }
  const byParent = new Map<string, string[]>()
  for (const path of paths) byParent.set(parentOf(path), [...(byParent.get(parentOf(path)) ?? []), path])
  await Promise.all([...byParent].map(async ([parent, moving]) => {
    const entries = await list(parent)
    for (const entry of entries.filter((one) => moving.includes(one.path))) {
      if (entry.type === 'file') { if (entry.id) ids.add(entry.id) } else await walk(entry.path)
    }
  }))
  return [...ids]
}

export const linksStopped = (shares: readonly Pick<FileShare, 'fileId'>[], ids: readonly string[]): { links: number; files: number } => {
  const moving = new Set(ids)
  const hit = shares.filter((share) => share.fileId !== undefined && moving.has(share.fileId))
  return { links: hit.length, files: new Set(hit.map((share) => share.fileId)).size }
}

export const movePrompt = ({ links, files }: { links: number; files: number }, several: boolean): string =>
  `Moving ${several ? 'these' : 'this'} stops ${links} share link${links === 1 ? '' : 's'}; whoever has ${links === 1 ? 'it' : 'them'} can no longer open ${files === 1 ? 'the file' : 'the files'}.`

const listed = (names: readonly string[]): string => {
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : [...names]
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

export const replacePrompt = (paths: readonly string[]): string =>
  paths.length === 1
    ? `Replace ${paths[0]}? The file there now is replaced and can't be brought back.`
    : `Replace ${listed(paths)}? The files there now are replaced and can't be brought back.`

export const roomText = (needed: number, free: number): string =>
  `This needs ${sizeText(needed)} and only ${sizeText(free)} is free, so nothing was uploaded.`

export const fits = (needed: number, free: number): boolean => needed <= free

export type UploadRefusal =
  | { kind: 'taken'; paths: string[] }
  | { kind: 'room'; needed: number; free: number }

const numberIn = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function uploadRefusal(status: number | undefined, body: unknown, sent: readonly string[]): UploadRefusal | undefined {
  const data = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (status === 409 && data.exists !== undefined) {
    const paths = Array.isArray(data.exists) ? data.exists.filter((one): one is string => typeof one === 'string') : []
    return { kind: 'taken', paths: paths.length ? paths : [...sent] }
  }
  const needed = numberIn(data.needed)
  const free = numberIn(data.free)
  if (status === 507 && needed !== undefined && free !== undefined) return { kind: 'room', needed, free }
  return undefined
}
