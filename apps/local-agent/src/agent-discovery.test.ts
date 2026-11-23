import { describe, expect, it } from 'vitest';
import { manualAnswerOf, reportAgents, type AgentsReport, type DiscoveryDeps } from './agent-discovery.js';

describe('what Koala answers when asked for the agents added by hand', () => {
  it('takes the agents it names, and fails with Koala\'s reason when it could not read them', () => {
    expect(manualAnswerOf([{ id: 'agy', command: '/opt/agy/agy' }])).toEqual([{ id: 'agy', command: '/opt/agy/agy', args: [] }]);
    expect(() => manualAnswerOf({ error: 'the machines collection could not be read' })).toThrow('Koala could not say which agents were added to this machine by hand: the machines collection could not be read');
  });
});

const gemini: DiscoveryDeps = {
  which: async (command) => (command === 'gemini' ? '/usr/bin/gemini' : undefined),
  exists: async () => false,
  probe: async () => ({ identity: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.61.0' }, signIn: [] }),
};

async function reported(deps: DiscoveryDeps, notSetUp: () => Promise<string | undefined>): Promise<AgentsReport[]> {
  const told: AgentsReport[] = [];
  await reportAgents(deps, [], notSetUp, (report) => { told.push(report); });
  return told;
}

describe('a machine reporting its coding agents', () => {
  it('reports the agents it finds, and nothing about setting them up when its last join set them up', async () => {
    const told = await reported(gemini, async () => undefined);
    expect(told.at(-1)).toEqual({ agents: [expect.objectContaining({ id: 'gemini', state: 'ready' })] });
  });

  it('reports why its last join could not set them up, beside the agents it finds', async () => {
    const told = await reported(gemini, async () => 'the ACP registry could not be reached');
    expect(told.at(-1)).toEqual({ agents: [expect.objectContaining({ id: 'gemini', state: 'ready' })], notSetUp: 'the ACP registry could not be reached' });
  });

  it('reports them as not set up, and why, when it cannot look for them', async () => {
    const broken: DiscoveryDeps = { ...gemini, which: async () => { throw new Error('PATH could not be read'); } };
    expect(await reported(broken, async () => undefined)).toEqual([{ agents: [], notSetUp: 'Koala could not look for the coding agents here: PATH could not be read' }]);
  });
});
