import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { childEnvWorld, namesIn } from '@koala/engine-core/testing/child-env';
import { AcpSessionError, probeAcp } from './acp-session.js';
import { createLocalFsDriver } from './local-fs-driver.js';
import { createMachineGit } from './machine-git.js';
import { runCommand } from './sandbox-handlers.js';

const SECRETS = ['SESSION_KEY', 'DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY', 'TEMPORAL_KEY', 'KOALA_DEVICE_TOKEN'];

describe('what a child process of the machine agent is handed', () => {
  const { dir, printsNames } = childEnvWorld('koala-agent-child-env-', SECRETS);
  const work = join(dir, 'work');

  beforeAll(() => {
    mkdirSync(work, { recursive: true });
  });

  it('gives a coding agent neither the device token nor a platform key', async () => {
    const agent = printsNames('coding-agent', 'err', 1);
    const failed = await probeAcp({ command: agent, args: [] }, work).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(AcpSessionError);
    const names = namesIn((failed as AcpSessionError).stderr);
    expect(names).toContain('PATH');
    for (const secret of SECRETS) expect(names).not.toContain(secret);
  });

  it('gives a model\'s command neither the device token nor a platform key', async () => {
    const driver = createLocalFsDriver({ rootDir: work, deviceId: 'desk' });
    const names = namesIn((await driver.exec({ command: 'env | cut -d= -f1' })).stdout);
    expect(names).toContain('PATH');
    for (const secret of SECRETS) expect(names).not.toContain(secret);
  });

  it('gives a command a run asks for neither the device token nor a platform key', async () => {
    const names = namesIn((await runCommand(work, 'env | cut -d= -f1')).stdout);
    expect(names).toContain('PATH');
    for (const secret of SECRETS) expect(names).not.toContain(secret);
  });

  it('gives git neither the device token nor a platform key', async () => {
    printsNames('git', 'err', 1);
    const git = createMachineGit({ rootDir: work, backendUrl: 'http://127.0.0.1:9', token: 'a-token' });
    const result = await git({ kind: 'checkout', repo: 'project', branch: 'main', folder: 'desk' });
    expect(result.ok).toBe(false);
    const names = namesIn(result.ok ? '' : result.error.replace(/^[^:]*: /, ''));
    expect(names).toContain('GIT_TERMINAL_PROMPT');
    for (const secret of SECRETS) expect(names).not.toContain(secret);
  });
});
