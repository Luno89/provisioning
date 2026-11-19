import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSessionError, probeAcp } from './acp-session.js';
import { createLocalFsDriver } from './local-fs-driver.js';
import { createMachineGit } from './machine-git.js';
import { runCommand } from './sandbox-handlers.js';

const SECRETS = ['SESSION_KEY', 'DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY', 'TEMPORAL_KEY', 'KOALA_DEVICE_TOKEN'];
const dir = mkdtempSync(join(tmpdir(), 'koala-agent-child-env-'));
const bin = join(dir, 'bin');
const work = join(dir, 'work');

const printsNames = (name: string): string => {
  const file = join(bin, name);
  writeFileSync(file, '#!/bin/sh\nenv | cut -d= -f1 >&2\nexit 1\n');
  chmodSync(file, 0o755);
  return file;
};

const namesIn = (said: string): string[] => said.split('\n').map((line) => line.trim()).filter(Boolean);

describe('what a child process of the machine agent is handed', () => {
  const before: Record<string, string | undefined> = {};

  beforeAll(() => {
    mkdirSync(bin, { recursive: true });
    mkdirSync(work, { recursive: true });
    for (const name of [...SECRETS, 'PATH']) before[name] = process.env[name];
    for (const name of SECRETS) process.env[name] = `${name.toLowerCase()}-never-handed-on-to-a-child-process`;
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('gives a coding agent neither the device token nor a platform key', async () => {
    const agent = printsNames('coding-agent');
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
    printsNames('git');
    const git = createMachineGit({ rootDir: work, backendUrl: 'http://127.0.0.1:9', token: 'a-token' });
    const result = await git({ kind: 'checkout', repo: 'project', branch: 'main', folder: 'desk' });
    expect(result.ok).toBe(false);
    const names = namesIn(result.ok ? '' : result.error.replace(/^[^:]*: /, ''));
    expect(names).toContain('GIT_TERMINAL_PROMPT');
    for (const secret of SECRETS) expect(names).not.toContain(secret);
  });
});
