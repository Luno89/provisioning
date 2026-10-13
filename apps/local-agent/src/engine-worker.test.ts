import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createDeviceActivities, deviceQueue, DEVICE_TOOLS } from './engine-worker.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-device-'));
  await fs.mkdir(path.join(rootDir, 'project'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'project/notes.md'), '# notes\n');
  await fs.writeFile(path.join(rootDir, 'private.env'), 'SECRET=hunter2\n');
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const activities = () => createDeviceActivities({ rootDir, deviceId: 'tallgeese' });

const call = (over: Record<string, unknown> = {}) => ({
  ticket: { runId: 'run-1', ownerId: 'user-1', agentSlug: 'executor' },
  nodeId: 'work',
  name: 'read_file',
  arguments: JSON.stringify({ path: 'project/notes.md' }),
  granted: ['run_command', 'read_file', 'write_file', 'list_dir'],
  ...over,
});

describe('device queue naming', () => {
  it('matches what the server schedules against', () => {
    expect(deviceQueue('tallgeese')).toBe('device-tallgeese');
  });
});

describe('device tool activity', () => {
  it('reads a real file on this machine', async () => {
    const outcome = await activities().EngineToolActivity(call());

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('# notes');
  });

  it('runs a real command on this machine', async () => {
    const outcome = await activities().EngineToolActivity(call({
      name: 'run_command',
      arguments: JSON.stringify({ command: 'echo ran here' }),
    }));

    expect(outcome.ok).toBe(true);
    expect(outcome.digest.trim()).toBe('ran here');
  });

  it('writes a file the server asked for', async () => {
    const outcome = await activities().EngineToolActivity(call({
      name: 'write_file',
      arguments: JSON.stringify({ path: 'project/new.txt', content: 'from the agent' }),
    }));

    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(path.join(rootDir, 'project/new.txt'), 'utf8')).toBe('from the agent');
  });

  it('honours the scope the server sent, and refuses to climb out of it', async () => {
    const scoped = call({
      environment: { scope: { deviceId: 'tallgeese', path: 'project' } },
      arguments: JSON.stringify({ path: 'notes.md' }),
    });

    expect((await activities().EngineToolActivity(scoped)).ok).toBe(true);

    const escaping = call({
      environment: { scope: { deviceId: 'tallgeese', path: 'project' } },
      arguments: JSON.stringify({ path: '../private.env' }),
    });

    const outcome = await activities().EngineToolActivity(escaping);
    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('points outside');
    expect(outcome.digest).not.toContain('hunter2');
  });

  it('enforces the grant list again on this side, not just on the server', async () => {
    const outcome = await activities().EngineToolActivity(call({
      name: 'delete_file',
      arguments: JSON.stringify({ path: 'project/notes.md' }),
      granted: ['read_file'],
    }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('not a tool this agent can use');
    await expect(fs.access(path.join(rootDir, 'project/notes.md'))).resolves.toBeUndefined();
  });

  it('refuses a tool this machine does not implement', async () => {
    const outcome = await activities().EngineToolActivity(call({
      name: 'search_web',
      arguments: '{}',
      granted: ['search_web'],
    }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no tool by that name is registered');
  });

  it('reports a failing command without throwing at Temporal', async () => {
    const outcome = await activities().EngineToolActivity(call({
      name: 'run_command',
      arguments: JSON.stringify({ command: 'exit 3' }),
    }));

    expect(outcome.ok).toBe(false);
  });

  it('only offers environment tools, since a machine has no platform tools', () => {
    expect(DEVICE_TOOLS.every((tool) => tool.binding === 'environment')).toBe(true);
  });
});

describe('a command on the person\'s own machine', () => {
  it('runs until it ends, and stops with everything it started when the run is stopped', async () => {
    const env = new MockActivityEnvironment();
    const running = env.run(activities().EngineToolActivity, call({ name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30 & sleep 30' }) }));
    setTimeout(() => env.cancel(), 300);
    const outcome = await running as Awaited<ReturnType<ReturnType<typeof activities>["EngineToolActivity"]>>;

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('[stopped because the run was stopped; everything it started was stopped too]');
  });

  it('stops at the timeoutSeconds the call set, and says so', async () => {
    const outcome = await activities().EngineToolActivity(call({ name: 'run_command', arguments: JSON.stringify({ command: 'echo started; sleep 30', timeoutSeconds: 1 }) }));

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('started');
    expect(outcome.content).toContain('[stopped after 1s, the timeoutSeconds this call set; everything it started was stopped too]');
  });
});
