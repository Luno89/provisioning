import { create } from 'zustand'
import type { ProjectDeletionMode } from '../types/project-removal'

export interface FollowedDeletion {
  projectId: string
  name: string
  mode: ProjectDeletionMode
}

interface DeletionsState {
  followed: FollowedDeletion[]
  follow: (deletion: FollowedDeletion) => void
  forget: (projectId: string) => void
}

export const useDeletionsStore = create<DeletionsState>((set) => ({
  followed: [],
  follow: (deletion) => set((state) => ({ followed: [...state.followed.filter((entry) => entry.projectId !== deletion.projectId), deletion] })),
  forget: (projectId) => set((state) => ({ followed: state.followed.filter((entry) => entry.projectId !== projectId) })),
}))
