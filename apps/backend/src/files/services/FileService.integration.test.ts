import { afterAll, beforeAll } from 'vitest';
import { fileServiceBehaviour } from '../testing/file-service-behaviour.js';
import { realStoredFiles, type RealStoredFiles } from '../testing/real-stored-files.js';

let real: RealStoredFiles;
beforeAll(async () => { real = await realStoredFiles(); });
afterAll(async () => { await real?.stop(); });

fileServiceBehaviour(async () => ({ files: real.files, shares: real.db.files }));
