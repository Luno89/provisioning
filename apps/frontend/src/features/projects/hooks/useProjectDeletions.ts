import { useQueryClient } from '@tanstack/react-query'
import { projectKeys } from '../api/projects'
import { useSocketEvent } from '../../platform'
import { latestProgress } from '../lib/project-deletion'
import { PROJECT_DELETION, type DeletionProgress, type ProjectDeletionEvent } from '../types/project-removal'

export function useProjectDeletions(): void {
  const client = useQueryClient()
  useSocketEvent<ProjectDeletionEvent>(PROJECT_DELETION, ({ projectId, progress }) => {
    client.setQueryData<DeletionProgress>(projectKeys.deletion(projectId), (known) => latestProgress(progress, known))
    if (progress.phase !== 'deleting') {
      for (const queryKey of [projectKeys.list(), projectKeys.deleted()]) void client.invalidateQueries({ queryKey })
    }
  })
}
