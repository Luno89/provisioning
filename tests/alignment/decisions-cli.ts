import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DECISIONS } from './decisions.js';
import { exportsOfFile } from './exports.js';
import { flowProblems, stepsOf } from './flow-spec.js';
import { registerPage } from './register-page.js';
import { registerProblems } from './register.js';
import { everythingSaid, transcriptsOf } from './transcripts.js';
import { V1_FLOWS } from './v1-flows.js';

const USAGE = 'usage: npm run decisions -- [--page <file.html>]';

async function main(): Promise<void> {
  const pageAt = process.argv.indexOf('--page');
  const page = pageAt >= 0 ? process.argv[pageAt + 1] : undefined;
  if (pageAt >= 0 && !page) throw new Error(USAGE);
  const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const root = git('rev-parse', '--show-toplevel');
  const said = await everythingSaid(transcriptsOf(join(homedir(), '.claude', 'projects'), dirname(resolve(commonDir))), join(commonDir, 'koala-said', 'cache.json'));
  const problems = [
    ...registerProblems(DECISIONS, said),
    ...flowProblems(V1_FLOWS, { decisions: new Set(DECISIONS.map((decision) => decision.id)), files: new Set(git('ls-files').split('\n')), exportsOf: exportsOfFile(root) }),
  ];
  for (const problem of problems) console.log(problem);
  const quotes = DECISIONS.reduce((count, decision) => count + decision.words.length + (decision.replaced?.length ?? 0), 0);
  const steps = V1_FLOWS.reduce((count, flow) => count + flow.steps.length, 0);
  if (problems.length > 0) {
    console.log(`${problems.length} problems in the register and the flows`);
    process.exitCode = 1;
    return;
  }
  console.log(`${DECISIONS.length} decisions, ${quotes} quotes, every one word for word in the transcripts; ${V1_FLOWS.length} flows, ${steps} steps, each on the register and on screens that exist`);
  if (page) {
    writeFileSync(page, registerPage(DECISIONS, stepsOf(V1_FLOWS), git('rev-parse', '--short=9', 'HEAD')));
    console.log(`the register's page is at ${page}`);
  }
}

main().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
