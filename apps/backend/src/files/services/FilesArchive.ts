import { Readable } from 'node:stream';
import { archivedArtifact, archivedObject, OLD_BUCKETS, type OldArtifact } from '../lib/files-archive.js';

export type { OldArtifact };
import type { OldBucketReader } from './ObjectStore.js';
import type { StoredFiles } from './StoredFiles.js';

export interface OldFileServer {
  ownerId: string;
  appName: string;
  reader: OldBucketReader;
}


export interface FilesArchiveDeps {
  servers(): Promise<OldFileServer[]>;
  oldArtifacts(): AsyncIterable<OldArtifact>;
  forgetOldArtifacts(): Promise<number>;
  files: Pick<StoredFiles, 'at'>;
}

export interface Archived {
  files: number;
  folders: number;
  artifacts: number;
  skipped: number;
}

const kept = (outcome: { ok: boolean; why?: string }, what: string): void => {
  if (!outcome.ok) throw new Error(`${what} could not be put in the Archive: ${outcome.why ?? 'refused'}`);
};

export async function archiveOldFiles(deps: FilesArchiveDeps): Promise<Archived> {
  const counts: Archived = { files: 0, folders: 0, artifacts: 0, skipped: 0 };
  for (const server of await deps.servers()) {
    const folder = deps.files.at(server.ownerId, { kind: 'person', id: server.ownerId });
    for (const bucket of OLD_BUCKETS) {
      if (!(await server.reader.has(bucket))) continue;
      for await (const object of server.reader.keys(bucket)) {
        const entry = archivedObject(server.appName, bucket, object.key);
        if (entry.kind === 'none') {
          counts.skipped += 1;
          continue;
        }
        if (entry.kind === 'folder') {
          kept(await folder.makeFolder(entry.path), entry.path);
          counts.folders += 1;
          continue;
        }
        const read = await server.reader.get(bucket, object.key);
        kept(await folder.upload(entry.path, read.body, object.size, read.contentType, { replace: true }), entry.path);
        counts.files += 1;
      }
    }
  }
  for await (const artifact of deps.oldArtifacts()) {
    const path = archivedArtifact(artifact.runId, artifact.name);
    if (!path) {
      counts.skipped += 1;
      continue;
    }
    const folder = deps.files.at(artifact.ownerId, { kind: 'person', id: artifact.ownerId });
    kept(await folder.upload(path, Readable.from([artifact.bytes]), artifact.bytes.length, artifact.contentType, { replace: true }), path);
    counts.artifacts += 1;
  }
  await deps.forgetOldArtifacts();
  return counts;
}
