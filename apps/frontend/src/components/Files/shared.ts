import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  chooseFileServer, fileKeys, getFilePlace, getFileServers, listStoredFiles, moveStoredFile, removeStoredFile,
  setDefaultFileServer, startProjectMinio, uploadStoredFile,
} from '../../api/files'
import { dropIntoRepository, projectFileKeys } from '../../api/project-files'
import { base64Of, joinPath, type PickedFile } from '../../lib/file-drop'
import type { FileScope, PlaceState } from '../../types/files'

export const STARTING_POLL_MS = 3000

export function useFileServers() {
  return useQuery({ queryKey: fileKeys.servers, queryFn: getFileServers })
}

export function useSetDefaultFileServer() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (deploymentId: string | null) => setDefaultFileServer(deploymentId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: fileKeys.all }) },
  })
}

export function useFilePlace(projectId: string) {
  return useQuery({
    queryKey: fileKeys.place(projectId),
    queryFn: () => getFilePlace(projectId),
    refetchInterval: (query) => ((query.state.data as PlaceState | undefined)?.state === 'starting' ? STARTING_POLL_MS : false),
  })
}

export function usePlaceChange(projectId: string) {
  const client = useQueryClient()
  const settle = (state: PlaceState) => {
    client.setQueryData(fileKeys.place(projectId), state)
    void client.invalidateQueries({ queryKey: fileKeys.all })
  }
  const choose = useMutation({ mutationFn: (deploymentId: string) => chooseFileServer(projectId, deploymentId), onSuccess: settle })
  const startMinio = useMutation({ mutationFn: () => startProjectMinio(projectId), onSuccess: settle })
  return { choose, startMinio }
}

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
  return { remove, move }
}

export function useRepositoryDrop(projectId: string, ref?: string | undefined) {
  const client = useQueryClient()
  const [share, setShare] = useState<number | undefined>()
  const drop = useMutation({
    mutationFn: async ({ dir, picked }: { dir: string; picked: PickedFile[] }) => {
      const files = await Promise.all(picked.map(async (one) => ({ path: one.path, content: await base64Of(one.file) })))
      return dropIntoRepository(projectId, { dir, files, ...(ref ? { ref } : {}) }, setShare)
    },
    onSettled: () => {
      setShare(undefined)
      void client.invalidateQueries({ queryKey: ['project-files', projectId] })
      void client.invalidateQueries({ queryKey: projectFileKeys.tree(projectId, '') })
    },
  })
  return { drop, share }
}

export const placeText = (state: PlaceState | undefined): string => {
  if (!state) return ''
  if (state.state === 'ready') return `${state.server.name} (${state.server.kind === 'minio' ? 'MinIO' : 'Nextcloud'}), in the folder ${state.place.folder}${state.chosen ? '' : ', your default'}`
  if (state.state === 'starting') return `${state.server} is starting; files can be added once it is running`
  if (state.state === 'gone') return `its file server cannot be reached: ${state.why}`
  return 'no file server yet'
}
