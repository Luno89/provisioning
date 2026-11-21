import { laterThan, namedWork, type DeletionProgress, type OpenWork } from '../lib/project-deletion.js';
import type { ProjectsStore } from '../store.js';

export const PROJECT_DELETION = 'project-deletion';

export interface ProjectDeletionEvent {
  projectId: string;
  progress: DeletionProgress;
}

export interface ProjectDeletionChange extends ProjectDeletionEvent {
  ownerId: string;
}

export interface ProjectDeletionNoticesDeps {
  store: Pick<ProjectsStore, 'deletion' | 'saveDeletionProgress'>;
  titles(ownerId: string): Promise<(work: OpenWork) => string>;
  emit(ownerId: string, event: ProjectDeletionEvent): void;
}

export class ProjectDeletionNotices {
  constructor(private readonly deps: ProjectDeletionNoticesDeps) {}

  async changed({ ownerId, projectId, progress }: ProjectDeletionChange): Promise<void> {
    const earlier = (await this.deps.store.deletion(projectId))?.progress;
    if (!laterThan(progress, earlier)) return;
    const named = namedWork(progress, await this.deps.titles(ownerId), earlier);
    await this.deps.store.saveDeletionProgress(projectId, named);
    this.deps.emit(ownerId, { projectId, progress: named });
  }
}
