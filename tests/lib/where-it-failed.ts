import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devPortForward } from './dev-stack.js';
import { callerLines, failuresUnder, flowsThrough, spansOf, whereLines, type CodeSite, type FlowSnapshot } from './failure-trace.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '../..');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const TEMPO_TRIES = 6;

interface Failed { scenarioId: string; trace?: { traceId: string; spanId: string } | undefined }

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => done(port));
  });
});

async function traceFrom(base: string, traceId: string, spanId: string): Promise<{ lines: string[]; sites: CodeSite[] } | string> {
  let last = '';
  for (let tried = 1; tried <= TEMPO_TRIES; tried += 1) {
    try {
      const answer = await fetch(`${base}/api/traces/${traceId}`);
      if (answer.ok) {
        const spans = spansOf(await answer.json() as Parameters<typeof spansOf>[0]);
        if (spans.some((span) => span.spanId === spanId)) {
          const failures = failuresUnder(spans, spanId);
          if (failures.length > 0) return { lines: whereLines(failures), sites: failures.flatMap((failure) => failure.sites) };
          last = 'its trace holds no request or step that failed, so it failed in what the check runner judged itself';
        } else last = `Tempo does not hold its span ${spanId} yet`;
      } else last = `Tempo answered ${answer.status}`;
    } catch (err) {
      last = `Tempo could not be asked: ${(err as Error).message}`;
    }
    if (last.startsWith('its trace')) return last;
    await sleep(5_000);
  }
  return `${last} (asked ${TEMPO_TRIES} times, 5 s apart; spans reach Tempo in batches)`;
}

function toolsOn(sites: readonly CodeSite[]): string[] {
  if (sites.length === 0) return [];
  const out = mkdtempSync(join(tmpdir(), 'where-it-failed-'));
  try {
    const flows = spawnSync('npm', ['run', 'flows', '--silent', '--', '--out', out], { cwd: REPO, encoding: 'utf8' });
    const snapshot = flows.status === 0 ? JSON.parse(readFileSync(join(out, 'snapshot.json'), 'utf8')) as FlowSnapshot : undefined;
    const seen = new Set<string>();
    return sites.flatMap((site) => {
      const key = `${site.filepath}#${site.function ?? site.lineno}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const name = site.function ? `${site.function} (${site.filepath}:${site.lineno ?? ''})` : `${site.filepath}:${site.lineno ?? ''}`;
      const on = snapshot ? flowsThrough(snapshot, site.filepath) : undefined;
      const lines = [`  ${name}`, `    on the flows: ${on === undefined ? `npm run flows failed: ${flows.stderr.trim().split('\n').at(-1) ?? ''}` : on.length > 0 ? on.join(', ') : 'none mapped'}`];
      if (site.function) {
        const refs = spawnSync('npm', ['run', 'refs', '--silent', '--', site.filepath, site.function], { cwd: REPO, encoding: 'utf8' });
        const callers = refs.status === 0 ? callerLines(refs.stdout) : [];
        lines.push(refs.status === 0 ? `    called from ${callers.length} place${callers.length === 1 ? '' : 's'}${callers.length ? ':' : ''}` : `    npm run refs failed: ${refs.stderr.trim().split('\n').at(-1) ?? ''}`);
        lines.push(...callers.slice(0, 10).map((caller) => `      ${caller.slice(0, 180)}`));
      }
      return lines;
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function whereItFailed(failed: readonly Failed[]): Promise<string[]> {
  if (failed.length === 0) return [];
  const port = await freePort();
  const forward = devPortForward('monitoring', 'svc/tempo', `${port}:3200`);
  try {
    const base = `http://127.0.0.1:${port}`;
    const lines: string[] = [];
    const sites: CodeSite[] = [];
    for (const result of failed) {
      lines.push(`\n    where ${result.scenarioId} failed:`);
      if (!result.trace) {
        lines.push('      its result carries no trace: it ran with no telemetry, or before checks carried their trace');
        continue;
      }
      const found = await traceFrom(base, result.trace.traceId, result.trace.spanId);
      if (typeof found === 'string') lines.push(`      ${found}; trace ${result.trace.traceId}`);
      else {
        lines.push(...found.lines.map((line) => `      ${line}`), `      trace ${result.trace.traceId} in Tempo`);
        sites.push(...found.sites);
      }
    }
    const tools = toolsOn(sites);
    if (tools.length > 0) lines.push('\n    the code it failed in:', ...tools);
    return lines;
  } finally {
    forward.kill();
  }
}
