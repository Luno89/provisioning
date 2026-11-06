import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DECISIONS } from './decisions.js';
import { registerPage } from './register-page.js';
import { registerProblems } from './register.js';
import { everythingSaid, transcriptsOf } from './transcripts.js';

async function main(): Promise<void> {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const transcripts = transcriptsOf(join(homedir(), '.claude', 'projects'), dirname(resolve(commonDir)));
  const said = await everythingSaid(transcripts, join(commonDir, 'koala-said', 'cache.json'));
  const problems = registerProblems(DECISIONS, said);
  for (const problem of problems) console.log(problem);
  const quotes = DECISIONS.reduce((count, decision) => count + decision.words.length + (decision.replaced?.length ?? 0), 0);
  console.log(problems.length === 0 ? `${DECISIONS.length} decisions, ${quotes} quotes, every one word for word in the transcripts` : `${problems.length} problems in the register`);
  if (problems.length > 0) process.exitCode = 1;
  const pageAt = process.argv.indexOf('--page');
  const page = pageAt >= 0 ? process.argv[pageAt + 1] : undefined;
  if (pageAt >= 0 && !page) throw new Error('usage: npm run decisions -- [--page <file.html>]');
  if (page && problems.length === 0) {
    const commit = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(page, registerPage(DECISIONS, commit));
    console.log(`the register's page is at ${page}`);
  }
}

main().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
