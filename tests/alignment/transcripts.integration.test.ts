import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAID_VERSION, everythingSaid, projectFolderName, transcriptsOf } from './transcripts.js';

const REPO = '/home/someone/Code/provisioning';
const typed = (text: string, at: string): string =>
  `${JSON.stringify({ type: 'user', timestamp: at, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } })}\n`;

const projects = (): { dir: string; main: string; agent: string; cache: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'koala-said-'));
  const folder = join(dir, projectFolderName(REPO));
  mkdirSync(join(folder, 'session-1', 'subagents'), { recursive: true });
  mkdirSync(join(dir, projectFolderName('/home/someone/Code/other')));
  mkdirSync(join(dir, `${projectFolderName(REPO)}-stage3`));
  writeFileSync(join(dir, `${projectFolderName(REPO)}-stage3`, 'session-2.jsonl'), typed('from the worktree', '2026-11-05T00:00:00.000Z'));
  writeFileSync(join(dir, projectFolderName('/home/someone/Code/other'), 'session-9.jsonl'), typed('another project', '2026-11-05T00:00:00.000Z'));
  const main = join(folder, 'session-1.jsonl');
  const agent = join(folder, 'session-1', 'subagents', 'agent-a1.jsonl');
  return { dir, main, agent, cache: join(dir, 'cache', 'said.json') };
};

describe('every transcript of the project, read once and then only what is new', () => {
  it('finds the session, its worktree\'s and its sub-agents\' transcripts, and no other project\'s', () => {
    const place = projects();
    writeFileSync(place.main, '');
    writeFileSync(place.agent, '');
    const found = transcriptsOf(place.dir, REPO).map((transcript) => [transcript.session, transcript.agent]);
    expect(found).toEqual(expect.arrayContaining([['session-1', undefined], ['session-1', 'agent-a1'], ['session-2', undefined]]));
    expect(found).toHaveLength(3);
  });

  it('reads what was said in order, keeps where it stopped, and reads a half-written line once it is whole', async () => {
    const place = projects();
    writeFileSync(place.main, typed('first', '2026-11-06T01:00:00.000Z'));
    writeFileSync(place.agent, typed('to the agent', '2026-11-06T02:00:00.000Z'));
    const half = typed('second', '2026-11-06T03:00:00.000Z');
    appendFileSync(place.main, half.slice(0, 40));
    const first = await everythingSaid(transcriptsOf(place.dir, REPO), place.cache);
    expect(first.map((entry) => entry.text)).toEqual(['from the worktree', 'first', 'to the agent']);

    appendFileSync(place.main, half.slice(40));
    const second = await everythingSaid(transcriptsOf(place.dir, REPO), place.cache);
    expect(second.map((entry) => entry.text)).toEqual(['from the worktree', 'first', 'to the agent', 'second']);
    expect(second.find((entry) => entry.text === 'to the agent')?.agent).toBe('agent-a1');
  });

  it('reads everything again when the saved progress is from another version of the reader', async () => {
    const place = projects();
    writeFileSync(place.main, typed('kept', '2026-11-06T01:00:00.000Z'));
    writeFileSync(place.agent, '');
    mkdirSync(join(place.dir, 'cache'));
    writeFileSync(place.cache, JSON.stringify({ version: SAID_VERSION - 1, files: { [place.main]: { size: 10_000_000, said: [] } } }));
    const said = await everythingSaid(transcriptsOf(place.dir, REPO), place.cache);
    expect(said.map((entry) => entry.text)).toContain('kept');
    expect((JSON.parse(readFileSync(place.cache, 'utf8')) as { version: number }).version).toBe(SAID_VERSION);
  });

  it('refuses when there is no folder of transcripts at all', () => {
    expect(() => transcriptsOf(join(tmpdir(), 'koala-said-nowhere'), REPO)).toThrow('there are no transcripts to search');
  });
});
