import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { getProjectFileContent, saveProjectFileContent, deleteProjectFile } from '../../api/project-files.js'
import { errorMessage } from '../../api/client.js'
import { isDirty, type OpenFile } from './shared.js'

export function useOpenFiles(projectId: string) {
  const qc = useQueryClient()
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [conflictPath, setConflictPath] = useState<string | null>(null)

  const active = openFiles.find((f) => f.path === activePath) ?? null

  const loadFile = async (path: string) => {
    const fresh = await getProjectFileContent(projectId, path)
    setOpenFiles((fs) => {
      const next = fs.filter((f) => f.path !== path)
      return [...next, { path: fresh.path, content: fresh.content, savedContent: fresh.content, sha: fresh.sha }]
    })
    setConflictPath((c) => (c === path ? null : c))
  }

  const openFile = async (path: string) => {
    setActivePath(path)
    if (openFiles.some((f) => f.path === path)) return
    setOpenFiles((fs) => [...fs, { path, content: '', savedContent: '', sha: '' }])
    setLoadingPath(path)
    try {
      await loadFile(path)
    } catch (err) {
      setOpenFiles((fs) => fs.map((f) => (f.path === path ? { ...f, error: errorMessage(err) } : f)))
    } finally {
      setLoadingPath(null)
    }
  }

  const closeFile = (path: string) => {
    const file = openFiles.find((f) => f.path === path)
    if (file && isDirty(file) && !window.confirm(`Discard unsaved changes to ${path}?`)) return

    const remaining = openFiles.filter((f) => f.path !== path)
    setOpenFiles(remaining)
    if (activePath === path) setActivePath(remaining[remaining.length - 1]?.path ?? null)
    if (conflictPath === path) setConflictPath(null)
  }

  const changeContent = (path: string, content: string) => {
    setOpenFiles((fs) => fs.map((f) => (f.path === path ? { ...f, content } : f)))
  }

  const saveFile = async (path: string) => {
    const file = openFiles.find((f) => f.path === path)
    if (!file) return
    setSavingPath(path)
    try {
      const result = await saveProjectFileContent(projectId, { path, content: file.content, sha: file.sha })
      setOpenFiles((fs) => fs.map((f) => (f.path === path ? { ...f, savedContent: f.content, sha: result.sha } : f)))
      setConflictPath(null)
      qc.invalidateQueries({ queryKey: ['project-files', projectId] })
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) setConflictPath(path)
      else setOpenFiles((fs) => fs.map((f) => (f.path === path ? { ...f, error: errorMessage(err) } : f)))
    } finally {
      setSavingPath(null)
    }
  }

  const deleteFile = async (path: string) => {
    const file = openFiles.find((f) => f.path === path)
    if (!file || !window.confirm(`Delete ${path}? This commits the deletion to the repository.`)) return
    try {
      await deleteProjectFile(projectId, path, file.sha)
      closeFile(path)
      qc.invalidateQueries({ queryKey: ['project-files', projectId] })
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) setConflictPath(path)
      else setOpenFiles((fs) => fs.map((f) => (f.path === path ? { ...f, error: errorMessage(err) } : f)))
    }
  }

  return {
    openFiles, activePath, setActivePath, active,
    loadingPath, savingPath, conflictPath,
    loadFile, openFile, closeFile, changeContent, saveFile, deleteFile,
  }
}
