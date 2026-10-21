import type { EngineExtension } from '@koala/agent-engine/procedure';
import { FILES_TOOLS, LIST_FILES, READ_STORED_FILE, REMOVE_STORED_FILE, STORE_FILE } from './catalogue.js';

export const FILES: EngineExtension = {
  id: 'files',
  title: 'Files',
  describe: 'A project\'s files that are not code, kept on the person\'s own file server (MinIO or Nextcloud): listed, read, stored and removed.',
  version: '1',
  requires: ['platform'],
  operations: [],
  tools: FILES_TOOLS,
  personas: [],
  grants: {
    koala: [LIST_FILES, READ_STORED_FILE, STORE_FILE, REMOVE_STORED_FILE],
    executor: [LIST_FILES, READ_STORED_FILE, STORE_FILE],
    research: [LIST_FILES, READ_STORED_FILE, STORE_FILE],
  },
  procedures: [],
};
