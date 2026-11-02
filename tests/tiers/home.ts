import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'koala-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.KUBECONFIG;
process.env.GIT_AUTHOR_NAME ??= 'Koala Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@koala.test';
process.env.GIT_COMMITTER_NAME ??= 'Koala Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@koala.test';

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
}, 0);
