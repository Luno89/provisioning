import { afterAll } from 'vitest'
import type { Database } from '../../../../backend/src/platform/lib/db-interface'
import { startMinio, testBucket } from '../../../../backend/src/files/testing/real-minio'
import { inProcessCommits } from '../../../../backend/src/files/testing/stored-files-twin'
import { minioObjectStore } from '../../../../backend/src/files/services/ObjectStore'
import { createStoredFilesActivities } from '../../../../backend/src/files/services/stored-files-activities'
import { StoredFiles } from '../../../../backend/src/files/services/StoredFiles'

export async function storedFilesOnMinio(db: Database, room: () => Promise<number> = async () => 1024 ** 3): Promise<StoredFiles> {
  const minio = await startMinio()
  afterAll(() => minio.stop())
  const objects = minioObjectStore({ ...minio.settings, bucket: testBucket() })
  const activities = createStoredFilesActivities({ records: db.files, objects })
  return new StoredFiles({ records: db.files, objects, commits: inProcessCommits(activities), room })
}
