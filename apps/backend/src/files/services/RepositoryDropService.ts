import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DroppedFile } from '../lib/drops.js';
import { dropMessage } from '../lib/drops.js';

export interface DropTarget {
  ownerId: string;
  giteaOwner?: string | undefined;
  giteaRepo?: string | undefined;
  executionTarget?: { kind: string; deviceId: string; path?: string | undefined } | undefined;
}

export interface RepositoryDropDeps {
  credential: (ownerId: string) => Promise<{ token: string }>;
  commit: (token: string, owner: string, repo: string, files: readonly { path: string; bytes: Buffer }[], message: string, branch?: string) => Promise<{ commit: string }>;
  writeOnDevice: (deviceId: string, ownerId: string, leafId: string, target: string, bytes: Buffer) => Promise<void>;
}

export type DropOutcome = { ok: true; paths: string[]; commit?: string | undefined } | { ok: false; why: string };

export class RepositoryDropService {
  constructor(private readonly deps: RepositoryDropDeps) {}

  async drop(project: DropTarget, files: readonly DroppedFile[], options: { ref?: string | undefined; message?: string | undefined } = {}): Promise<DropOutcome> {
    const paths = files.map((file) => file.path);
    if (project.executionTarget?.kind === 'local-device') {
      const { deviceId, path: base } = project.executionTarget;
      for (const file of files) {
        await this.deps.writeOnDevice(deviceId, project.ownerId, `files-drop-${randomUUID()}`, base ? path.posix.join(base, file.path) : file.path, file.bytes);
      }
      return { ok: true, paths };
    }
    if (!project.giteaOwner || !project.giteaRepo) return { ok: false, why: 'This project has no repository to drop files into.' };
    const { token } = await this.deps.credential(project.ownerId);
    const { commit } = await this.deps.commit(token, project.giteaOwner, project.giteaRepo, files, dropMessage(files, options.message), options.ref);
    return { ok: true, paths, commit };
  }
}
