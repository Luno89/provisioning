import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { excerpt, matching } from './said.js';
import { everythingSaid, transcriptsOf } from './transcripts.js';

const USAGE = 'usage: npm run said -- [--since YYYY-MM-DD] [--full] <word> [more words, all must appear]';

const args = process.argv.slice(2);
const full = args.includes('--full');
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? args[sinceAt + 1] : undefined;
if (sinceAt >= 0 && !since) throw new Error(USAGE);
const words = args.filter((arg, index) => !arg.startsWith('--') && (sinceAt < 0 || index !== sinceAt + 1));
if (words.length === 0) throw new Error(USAGE);

async function main(): Promise<void> {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const repoRoot = dirname(resolve(commonDir));
  const transcripts = transcriptsOf(join(homedir(), '.claude', 'projects'), repoRoot);
  const said = await everythingSaid(transcripts, join(commonDir, 'koala-said', 'cache.json'));
  const found = matching(said, words, since);

  for (const entry of found) {
    const where = entry.agent ? `${entry.session.slice(0, 8)}/${entry.agent.slice(0, 14)}` : entry.session.slice(0, 8);
    const asked = entry.question ? `  asked: ${excerpt(entry.question, words, 200)}\n` : '';
    const text = full ? entry.text : excerpt(entry.text, words, 400);
    console.log(`${entry.at.slice(0, 16).replace('T', ' ')}  ${entry.how.padEnd(13)} ${where}\n${asked}  ${text.split('\n').join('\n  ')}\n`);
  }
  console.log(`${found.length} of ${said.length} things you said match ${words.map((word) => `"${word}"`).join(' and ')}${since ? ` since ${since}` : ''}`);
}

main().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
