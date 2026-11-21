import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isAxiosError } from 'axios'
import {
  dropStoredFiles, fileKeys, listFileShares, listStoredFiles, makeStoredFolder, moveStoredFile, removeStoredFile,
  revokeFileShare, searchStoredFiles, shareStoredFile, storedRoom, uploadStoredFile,
} from './api/files'
import { dropIntoRepository, projectFileKeys } from '../projects'
import { groveKeys } from '../projects'
import { joinPath, type PickedFile } from './lib/file-drop'
import {
  fileIdsUnder, fits, linksStopped, takenPaths, targetPaths, totalSize, uploadRefusal, uploadWay,
  type Upload, type UploadRefusal,
} from './lib/file-upload'
import type { FileScope, ShareDays } from './types'

export function useStoredFiles(scope: FileScope, dir: string, enabled = true) {
  return useQuery({ queryKey: fileKeys.list(scope, dir), queryFn: () => listStoredFiles(scope, dir), enabled })
}

export interface UploadProgress {
  done: number
  total: number
  current?: string | undefined
  share: number
}

export type UploadOutcome =
  | { kind: 'sent'; paths: string[] }
  | UploadRefusal

const refusalOf = (err: unknown, sent: readonly string[]): UploadRefusal | undefined =>
  isAxiosError(err) ? uploadRefusal(err.response?.status, err.response?.data, sent) : undefined

export function useStoredUpload(scope: FileScope) {
  const client = useQueryClient()
  const [progress, setProgress] = useState<UploadProgress | undefined>()
  const list = (dir: string) => client.fetchQuery({ queryKey: fileKeys.list(scope, dir), queryFn: () => listStoredFiles(scope, dir), staleTime: 0 })
  const send = async ({ dir, picked }: Upload, replace: boolean): Promise<string[]> => {
    const way = uploadWay(picked.length)
    if (way === 'drop') {
      setProgress({ done: 0, total: picked.length, share: 0 })
      const { files } = await dropStoredFiles(scope, dir, picked, replace, (share) => setProgress({ done: 0, total: picked.length, share }))
      return files.map((one) => one.path)
    }
    const stored: string[] = []
    for (const [index, one] of picked.entries()) {
      setProgress({ done: index, total: picked.length, current: one.path, share: 0 })
      const path = joinPath(dir, one.path)
      await uploadStoredFile(scope, path, one.file, (share) => setProgress({ done: index, total: picked.length, current: one.path, share }), replace)
      stored.push(path)
    }
    return stored
  }
  const upload = useMutation({
    mutationFn: async ({ upload: wanted, replace }: { upload: Upload; replace: boolean }): Promise<UploadOutcome> => {
      const targets = targetPaths(wanted)
      if (!replace) {
        const needed = totalSize(wanted.picked)
        const { free } = await storedRoom()
        if (!fits(needed, free)) return { kind: 'room', needed, free }
      }
      if (!replace) {
        const taken = await takenPaths(list, targets)
        if (taken.length) return { kind: 'taken', paths: taken }
      }
      try {
        return { kind: 'sent', paths: await send(wanted, replace) }
      } catch (err) {
        const refusal = refusalOf(err, targets)
        if (refusal) return refusal
        throw err
      }
    },
    onSettled: () => {
      setProgress(undefined)
      void client.invalidateQueries({ queryKey: fileKeys.all })
    },
  })
  return { upload, progress }
}

export interface Move {
  from: string
  to: string
}

export type MoveOutcome =
  | { kind: 'moved' }
  | { kind: 'links'; links: number; files: number }

export function useStoredChanges(scope: FileScope) {
  const client = useQueryClient()
  const refresh = () => { void client.invalidateQueries({ queryKey: fileKeys.all }) }
  const list = (dir: string) => client.fetchQuery({ queryKey: fileKeys.list(scope, dir), queryFn: () => listStoredFiles(scope, dir), staleTime: 0 })
  const removeMany = useMutation({
    mutationFn: async (paths: readonly string[]) => { for (const path of paths) await removeStoredFile(scope, path) },
    onSettled: refresh,
  })
  const moveMany = useMutation({
    mutationFn: async ({ moves, confirmed }: { moves: readonly Move[]; confirmed: boolean }): Promise<MoveOutcome> => {
      if (!confirmed) {
        const shares = await client.fetchQuery({ queryKey: fileKeys.shares, queryFn: listFileShares, staleTime: 0 })
        if (shares.some((share) => share.fileId)) {
          const stopped = linksStopped(shares, await fileIdsUnder(list, moves.map((one) => one.from)))
          if (stopped.links > 0) return { kind: 'links', ...stopped }
        }
      }
      for (const one of moves) await moveStoredFile(scope, one.from, one.to)
      return { kind: 'moved' }
    },
    onSettled: (outcome) => {
      refresh()
      if (outcome?.kind === 'moved') void client.invalidateQueries({ queryKey: fileKeys.shares })
    },
  })
  const makeFolder = useMutation({ mutationFn: (path: string) => makeStoredFolder(scope, path), onSuccess: refresh })
  return { removeMany, moveMany, makeFolder }
}

export function useStoredSearch(scope: FileScope, query: string) {
  const wanted = query.trim()
  return useQuery({ queryKey: fileKeys.search(scope, wanted), queryFn: () => searchStoredFiles(scope, wanted), enabled: wanted.length > 0 })
}

export function useFileShares() {
  return useQuery({ queryKey: fileKeys.shares, queryFn: listFileShares })
}

export function useShareFile(scope: FileScope) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ path, days }: { path: string; days: ShareDays }) => shareStoredFile(scope, path, days),
    onSuccess: () => { void client.invalidateQueries({ queryKey: fileKeys.shares }) },
  })
}

export function useRevokeShare() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeFileShare(id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: fileKeys.shares }) },
  })
}

export function useRepositoryDrop(projectId: string, ref?: string | undefined, leafId?: string | undefined) {
  const client = useQueryClient()
  const [share, setShare] = useState<number | undefined>()
  const drop = useMutation({
    mutationFn: ({ dir, picked }: { dir: string; picked: PickedFile[] }) =>
      dropIntoRepository(projectId, { dir, ...(ref ? { ref } : {}), ...(leafId ? { leafId } : {}) }, picked, setShare),
    onSettled: () => {
      setShare(undefined)
      void client.invalidateQueries({ queryKey: ['project-files', projectId] })
      void client.invalidateQueries({ queryKey: projectFileKeys.tree(projectId, '') })
      if (leafId) void client.invalidateQueries({ queryKey: groveKeys.leaves() })
    },
  })
  return { drop, share }
}
