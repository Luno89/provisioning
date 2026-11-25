import { describe, expect, it } from 'vitest';
import { ExternalAgentSessions } from './external-agents.js';
import type { ExternalAgentStepResult } from '@koala/engine-core';

const failure = (step: ExternalAgentStepResult): string => (step.state === 'failed' ? step.error : `it did not fail: ${step.state}`);
const open = (sessions: ExternalAgentSessions, key: string) => sessions.step({ key, agent: 'antigravity', op: { kind: 'open', brief: 'go' } });

describe('external agents before the machine has found them', () => {
  it('holds a session until the machine has looked, then refuses only an agent it looked for and did not find', async () => {
    const sessions = new ExternalAgentSessions({ rootDir: '/home/person/koala' });
    let answered = false;
    const opening = open(sessions, 'k').finally(() => { answered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    sessions.setLaunches({});
    expect(failure(await opening)).toBe('this machine has no agent called antigravity');
  });

  it('ends a session waiting for the machine to find its agents with why, when finding them failed', async () => {
    const sessions = new ExternalAgentSessions({ rootDir: '/home/person/koala' });
    const opening = open(sessions, 'k');
    sessions.notFound('Koala did not answer which agents were added by hand');
    expect(failure(await opening)).toBe('this machine could not find its agents: Koala did not answer which agents were added by hand');
    expect(failure(await open(sessions, 'k2'))).toBe('this machine could not find its agents: Koala did not answer which agents were added by hand');
  });

  it('keeps the agents it found once it has looked, even when a later look fails', async () => {
    const sessions = new ExternalAgentSessions({ rootDir: '/home/person/koala', launches: {} });
    sessions.notFound('the look failed this time');
    expect(failure(await open(sessions, 'k'))).toBe('this machine has no agent called antigravity');
  });
});
