import { describe, expect, it } from 'vitest';
import type { Persona } from './agent.js';
import { grantChanges, grantsFrom, sourcedTools, toolsOf, toRecord, withGrants, type ToolGrant } from './grants.js';
import type { PersonaRecord } from './agent.js';

const shipped = grantsFrom({ executor: ['run_command', 'read_file', 'write_file'], judge: ['read_file'] });
const mine = (tool: string, revoked = false): ToolGrant => ({ ownerId: 'u1', agent: 'executor', tool, ...(revoked ? { revoked } : {}) });

describe('what an agent holds', () => {
  it('is what ships for it, in the order it ships, then what the person granted, less what they took away', () => {
    expect(toolsOf('executor', shipped, [mine('browser'), mine('write_file', true)])).toEqual(['run_command', 'read_file', 'browser']);
  });

  it('says where each came from, taken-away ones included so they can be given back', () => {
    expect(sourcedTools('executor', shipped, [mine('browser'), mine('write_file', true)])).toEqual([
      { tool: 'run_command', source: 'shipped' },
      { tool: 'read_file', source: 'shipped' },
      { tool: 'write_file', source: 'revoked' },
      { tool: 'browser', source: 'granted' },
    ]);
  });

  it('is only the person\'s grants for an agent of their own, and nothing for one with none', () => {
    const own = [{ ownerId: 'u1', agent: 'helper', tool: 'read_file' }];
    expect(toolsOf('helper', shipped, own)).toEqual(['read_file']);
    expect(toolsOf('nobody', shipped, own)).toEqual([]);
  });

  it('counts a tool once, however many grants name it', () => {
    expect(toolsOf('executor', shipped, [mine('read_file'), mine('browser'), mine('browser')])).toEqual(['run_command', 'read_file', 'write_file', 'browser']);
  });

  it('resolves stored agents into agents with their tools, and back', () => {
    const records = [{ slug: 'judge', name: 'Judge' }, { slug: 'executor', name: 'Executor' }] as PersonaRecord[];
    const resolved = withGrants(records, shipped, [mine('browser')]);
    expect(resolved.map((agent) => [agent.slug, agent.tools])).toEqual([['judge', ['read_file']], ['executor', ['run_command', 'read_file', 'write_file', 'browser']]]);
    expect(toRecord(resolved[0]!)).toEqual(records[0]);
  });
});

describe('changing what an agent holds', () => {
  it('grants what is wanted and not held, and takes away what ships but is not wanted', () => {
    expect(grantChanges('executor', ['run_command', 'browser'], shipped, [])).toEqual({ grant: ['browser'], revoke: ['read_file', 'write_file'], drop: [] });
  });

  it('gives a taken-away tool back by dropping the revocation, and drops a grant no longer wanted', () => {
    const person = [mine('write_file', true), mine('browser')];
    expect(grantChanges('executor', ['run_command', 'read_file', 'write_file'], shipped, person)).toEqual({ grant: [], revoke: [], drop: ['browser', 'write_file'] });
  });

  it('changes nothing when what is wanted is what it holds', () => {
    const person = [mine('browser'), mine('write_file', true)];
    expect(grantChanges('executor', toolsOf('executor', shipped, person), shipped, person)).toEqual({ grant: [], revoke: [], drop: [] });
  });

  it('drops a person\'s grant of a tool that now ships, since it is held either way', () => {
    expect(grantChanges('executor', ['run_command', 'read_file', 'write_file'], shipped, [mine('read_file')])).toEqual({ grant: [], revoke: [], drop: ['read_file'] });
  });
});

describe('the MCP servers an agent holds', () => {
  const server = (name: string, revoked = false): ToolGrant => ({ ownerId: 'u1', agent: 'executor', tool: name, kind: 'server', ...(revoked ? { revoked } : {}) });

  it('are granted apart from its tools, even under a tool\'s name', () => {
    const person = [mine('browser'), server('playwright'), server('read_file')];
    expect(toolsOf('executor', shipped, person)).toEqual(['run_command', 'read_file', 'write_file', 'browser']);
    expect(toolsOf('executor', shipped, person, 'server')).toEqual(['playwright', 'read_file']);
    const [resolved] = withGrants([{ slug: 'executor', name: 'Executor' } as PersonaRecord], shipped, person);
    expect(resolved!.servers).toEqual(['playwright', 'read_file']);
    expect(toRecord(resolved!)).toEqual({ slug: 'executor', name: 'Executor' });
  });

  it('never stores what its steps need, which is worked out each time it is read', () => {
    const resolved = { slug: 'executor', name: 'Executor', tools: [], needs: ['koala-e2e'], needsFrom: [{ name: 'koala-e2e', from: 'step:Run Browser Tests' }] } as unknown as Persona;
    expect(toRecord(resolved)).toEqual({ slug: 'executor', name: 'Executor' });
  });

  it('change on their own', () => {
    expect(grantChanges('executor', ['docs'], shipped, [server('playwright'), mine('browser')], 'server')).toEqual({ grant: ['docs'], revoke: [], drop: ['playwright'] });
  });
});
