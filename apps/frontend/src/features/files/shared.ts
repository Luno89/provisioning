import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  fileKeys, listFileShares, listStoredFiles, makeStoredFolder, moveStoredFile, removeStoredFile,
  revokeFileShare, searchStoredFiles, shareStoredFile, uploadStoredFile,
} from './api/files'
import { dropIntoRepository, projectFileKeys } from '../projects'
import { groveKeys } from '../projects'
import { joinPath, type PickedFile } from './lib/file-drop'
import type { FileScope, ShareableScope, ShareDays } from './types'

export function useStoredFiles(scope: FileScope, dir: string, enabled = true) {
  return useQuery({ queryKey: fileKeys.list(scope, dir), queryFn: () => listStoredFiles(scope, dir), enabled })
}

export interface UploadProgress {
  done: number
  total: number
  current?: string | undefined
  share: number
}

export function useStoredUpload(scope: FileScope) {
  const client = useQueryClient()
  const [progress, setProgress] = useState<UploadProgress | undefined>()
  const upload = useMutation({
    mutationFn: async ({ dir, picked }: { dir: string; picked: PickedFile[] }) => {
      const stored: string[] = []
      for (const [index, one] of picked.entries()) {
        setProgress({ done: index, total: picked.length, current: one.path, share: 0 })
        const path = joinPath(dir, one.path)
        await uploadStoredFile(scope, path, one.file, (share) => setProgress({ done: index, total: picked.length, current: one.path, share }))
        stored.push(path)
      }
      return stored
    },
    onSettled: () => {
      setProgress(undefined)
      void client.invalidateQueries({ queryKey: fileKeys.all })
    },
  })
  return { upload, progress }
}

export function useStoredChanges(scope: FileScope) {
  const client = useQueryClient()
  const refresh = () => { void client.invalidateQueries({ queryKey: fileKeys.all }) }
  const remove = useMutation({ mutationFn: (path: string) => removeStoredFile(scope, path), onSuccess: refresh })
  const move = useMutation({ mutationFn: ({ from, to }: { from: string; to: string }) => moveStoredFile(scope, from, to), onSuccess: refresh })
  const removeMany = useMutation({
    mutationFn: async (paths: readonly string[]) => { for (const path of paths) await removeStoredFile(scope, path) },
    onSettled: refresh,
  })
  const moveMany = useMutation({
    mutationFn: async (moves: readonly { from: string; to: string }[]) => { for (const one of moves) await moveStoredFile(scope, one.from, one.to) },
    onSettled: refresh,
  })
  const makeFolder = useMutation({ mutationFn: (path: string) => makeStoredFolder(scope, path), onSuccess: refresh })
  return { remove, move, removeMany, moveMany, makeFolder }
}

export function useStoredSearch(scope: FileScope, query: string) {
  const wanted = query.trim()
  return useQuery({ queryKey: fileKeys.search(scope, wanted), queryFn: () => searchStoredFiles(scope, wanted), enabled: wanted.length > 0 })
}

export function useFileShares() {
  return useQuery({ queryKey: fileKeys.shares, queryFn: listFileShares })
}

export function useShareFile(scope: ShareableScope) {
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
