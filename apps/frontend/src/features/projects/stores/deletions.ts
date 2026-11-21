import { create } from 'zustand'
import type { ProjectDeletionMode, RestoredProject } from '../types/project-removal'

export interface FollowedDeletion {
  projectId: string
  name: string
  mode: ProjectDeletionMode
}

interface DeletionsState {
  followed: FollowedDeletion[]
  restored: Record<string, RestoredProject>
  follow: (deletion: FollowedDeletion) => void
  forget: (projectId: string) => void
  noteRestored: (projectId: string, restored: RestoredProject) => void
  dismissRestored: (projectId: string) => void
}

export const useDeletionsStore = create<DeletionsState>((set) => ({
  followed: [],
  restored: {},
  follow: (deletion) => set((state) => ({ followed: [...state.followed.filter((entry) => entry.projectId !== deletion.projectId), deletion] })),
  forget: (projectId) => set((state) => ({ followed: state.followed.filter((entry) => entry.projectId !== projectId) })),
  noteRestored: (projectId, restored) => set((state) => ({ restored: { ...state.restored, [projectId]: restored } })),
  dismissRestored: (projectId) => set((state) => ({ restored: Object.fromEntries(Object.entries(state.restored).filter(([id]) => id !== projectId)) })),
}))
