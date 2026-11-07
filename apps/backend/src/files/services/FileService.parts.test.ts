import { fileServiceBehaviour } from '../testing/file-service-behaviour.js';
import { storedFilesTwin } from '../testing/stored-files-twin.js';

fileServiceBehaviour(async () => {
  const twin = storedFilesTwin({ now: Date.now() });
  return { files: twin.files, shares: twin.records };
});
