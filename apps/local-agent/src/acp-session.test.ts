import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { openAcpSession, probeAcp } from './acp-session.js';

const launch = { command: 'claude-code-acp', args: ['--stdio'], env: { CLAUDE_CONFIG_DIR: '/home/person/.claude' } };

describe('a coding agent that is not on the machine', () => {
  it('is said to be missing when probed, and was asked for in the folder with its own environment', async () => {
    const streams = recordingProcesses(() => undefined);
    await expect(probeAcp(launch, '/work', streams)).rejects.toThrow('could not start claude-code-acp: spawn claude-code-acp ENOENT');
    expect(streams.recorded[0]?.run).toMatchObject({ command: 'claude-code-acp', args: ['--stdio'], cwd: '/work', env: { CLAUDE_CONFIG_DIR: '/home/person/.claude' } });
  });

  it('is said to be missing when a session is opened', async () => {
    const streams = recordingProcesses(() => undefined);
    await expect(openAcpSession({ launch, cwd: '/work', streams, onEvent: () => undefined, onPermission: async () => ({ cancelled: true }) })).rejects.toThrow('could not start claude-code-acp');
  });

  it('is said to have exited when it ends before answering', async () => {
    const streams = recordingProcesses(() => ({ stderr: 'not signed in\n', code: 2 }));
    await expect(probeAcp(launch, '/work', streams)).rejects.toThrow('claude-code-acp exited (2) without answering as an ACP agent\nnot signed in');
  });
});
