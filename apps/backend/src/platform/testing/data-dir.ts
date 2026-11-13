import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const testDataDir = (): string => join(tmpdir(), `koala-test-data-${randomUUID()}`);
