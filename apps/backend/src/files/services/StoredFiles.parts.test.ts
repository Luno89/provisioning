import { storedFilesContract } from '../testing/stored-files-contract.js';
import { storedFilesTwin } from '../testing/stored-files-twin.js';

storedFilesContract(async () => {
  const clock = { now: Date.parse('2026-11-07T10:00:00.000Z') };
  const twin = storedFilesTwin(clock);
  return { files: twin.files, objects: twin.objects, records: twin.records, sweep: () => twin.activities.StoredFilesSweepActivity(), clock };
});
