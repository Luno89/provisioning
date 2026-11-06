import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { Readable } from 'node:stream'
import type { FileStore } from '../../../../backend/src/files/services/FileStores'
import type { FileEntry, FilePlace } from '../../../../backend/src/files/lib/file-places'

export interface MinioStandIn {
  open: (ownerId: string, place: FilePlace) => Promise<FileStore>
  typeOf: (folder: string, path: string) => string | undefined
}

export async function minioStandIn(): Promise<MinioStandIn> {
  const bucket = await mkdtemp(join(tmpdir(), 'koala-files-'))
  const types = new Map<string, string>()
  const walk = async (root: string, dir: string): Promise<FileEntry[]> => {
    const found: FileEntry[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...await walk(root, full))
      else if (entry.name !== '.keep') found.push({ name: entry.name, path: relative(root, full), type: 'file', size: (await stat(full)).size })
    }
    return found
  }
  const open = async (_ownerId: string, place: FilePlace): Promise<FileStore> => {
    const root = join(bucket, place.folder)
    await mkdir(root, { recursive: true })
    const at = (path: string) => join(root, path)
    return {
      list: async (dir) => {
        const entries = await readdir(at(dir), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return []
          throw err
        })
        const listed: FileEntry[] = []
        for (const entry of entries) {
          if (entry.name === '.keep') continue
          const path = dir ? `${dir}/${entry.name}` : entry.name
          listed.push(entry.isDirectory() ? { name: entry.name, path, type: 'dir' } : { name: entry.name, path, type: 'file', size: (await stat(at(path))).size })
        }
        return listed
      },
      search: async (query) => (await walk(root, root)).filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase())),
      download: async (path) => {
        const bytes = await readFile(at(path)).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined
          throw err
        })
        if (!bytes) return undefined
        return { stream: createReadStream(at(path)), size: bytes.length, contentType: types.get(at(path)) ?? 'application/octet-stream', etag: createHash('md5').update(bytes).digest('hex') }
      },
      upload: async (path, body: Readable, _size, contentType) => {
        const parts: Buffer[] = []
        for await (const part of body) parts.push(Buffer.from(part as Buffer))
        await mkdir(dirname(at(path)), { recursive: true })
        await writeFile(at(path), Buffer.concat(parts))
        types.set(at(path), contentType)
      },
      makeFolder: async (path) => {
        await mkdir(at(path), { recursive: true })
        await writeFile(join(at(path), '.keep'), '')
      },
      remove: async (path) => { await rm(at(path), { force: true }) },
      move: async (from, to) => {
        await mkdir(dirname(at(to)), { recursive: true })
        await rename(at(from), at(to))
        const type = types.get(at(from))
        if (type) types.set(at(to), type)
      },
      removeAll: async () => { await rm(root, { recursive: true, force: true }) },
    }
  }
  return { open, typeOf: (folder, path) => types.get(join(bucket, folder, path)) }
}
