import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { unpromptedGit } from './git-env.js';

const run = promisify(execFile);

describe('git run by Koala', () => {
  it('fails at once on a remote that wants a password, never asking the desktop for one', async () => {
    const server = createServer((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Gitea"' }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = mkdtempSync(join(tmpdir(), 'git-env-'));
    const asked = join(dir, 'asked');
    const askpass = join(dir, 'askpass.sh');
    writeFileSync(askpass, `#!/bin/sh\ntouch ${asked}\necho guess\n`, { mode: 0o755 });
    const helper = join(dir, 'helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch ${asked}\n`, { mode: 0o755 });
    const global = join(dir, 'gitconfig');
    writeFileSync(global, `[credential]\n\thelper = ${helper}\n[core]\n\taskPass = ${askpass}\n`);
    const desktop = { ...process.env, SSH_ASKPASS: askpass, GIT_ASKPASS: askpass, DISPLAY: ':0', SSH_ASKPASS_REQUIRE: 'force', GIT_CONFIG_GLOBAL: global };
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/shared/project.git`;
      const answer = await run('git', ['ls-remote', url], { env: unpromptedGit(desktop, { 'gc.auto': '0' }) }).then(() => 'answered', (err: Error) => err.message);
      expect(answer).toMatch(/terminal prompts disabled|could not read Username|Authentication failed/);
      expect(existsSync(asked)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('keeps what the caller configures after its own settings', () => {
    const env = unpromptedGit({ PATH: '/bin', SSH_ASKPASS: 'x', GIT_CONFIG_COUNT: '9' }, { 'http.extraHeader': 'Authorization: Basic abc' });
    expect(env).toEqual({
      PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'http.extraHeader', GIT_CONFIG_VALUE_2: 'Authorization: Basic abc',
    });
  });
});
