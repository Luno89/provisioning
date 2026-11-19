import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Copy, Scope } from './rules.js';

export const MIN_TOKENS = 50;

interface ScopeOptions { paths: (root: string) => string[]; format: string; pattern?: string; ignore: string[] }

const packageSources = (root: string): string[] => readdirSync(join(root, 'packages')).map((name) => `packages/${name}/src`).filter((path) => existsSync(join(root, path))).sort();

export const SCOPES: Record<Scope, ScopeOptions> = {
  src: {
    paths: (root) => ['apps/backend/src', 'apps/frontend/src', 'apps/local-agent/src', ...packageSources(root), 'packages/cdktf-infra'],
    format: 'typescript,tsx,javascript',
    ignore: ['**/*.test.ts', '**/*.test.tsx', '**/*.integration.test.ts', '**/*.integration.test.tsx', '**/testing/**', '**/test/**', '**/node_modules/**', '**/dist/**', '**/.gen/**', '**/imports/**', '**/cdktf.out/**', '**/*.d.ts'],
  },
  tests: {
    paths: () => ['apps', 'packages', 'tests'],
    format: 'typescript,tsx',
    pattern: '**/*.{test,integration.test}.{ts,tsx}',
    ignore: ['**/node_modules/**', '**/dist/**', '**/.gen/**', '**/cdktf.out/**'],
  },
};

const JSCPD = join(dirname(createRequire(import.meta.url).resolve('jscpd')), '..', 'bin', 'jscpd');

interface Located { name: string; start: number; end: number }
interface Reported { lines: number; fragment: string; firstFile: Located; secondFile: Located }

const sideOf = (file: Located, lines: number) => ({ file: file.name, start: file.start, end: file.end >= file.start ? file.end : file.start + lines - 1 });

function scanned(root: string, scope: Scope): Promise<Copy[]> {
  const options = SCOPES[scope];
  const paths = options.paths(root);
  const missing = paths.filter((path) => !existsSync(join(root, path)));
  if (missing.length > 0) return Promise.reject(new Error(`the ${scope} scope names ${missing.join(', ')}, which ${root} does not have`));
  const out = mkdtempSync(join(tmpdir(), `copies-${scope}-`));
  const args = [JSCPD, ...paths, '--format', options.format, ...(options.pattern ? ['--pattern', options.pattern] : []), '--ignore', options.ignore.join(','), '--min-tokens', String(MIN_TOKENS), '--reporters', 'json', '--output', out, '--silent'];
  return new Promise<Copy[]>((done, failed) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    child.on('error', failed);
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(`jscpd on the ${scope} scope exited ${code}: ${said.trim()}`);
        if (!existsSync(join(out, 'jscpd-report.json'))) throw new Error(`jscpd found no files in the ${scope} scope (${paths.join(', ')})`);
        const report = JSON.parse(readFileSync(join(out, 'jscpd-report.json'), 'utf8')) as { duplicates: Reported[] };
        done(report.duplicates.map((found) => ({ scope, a: sideOf(found.firstFile, found.lines), b: sideOf(found.secondFile, found.lines), fragment: found.fragment })));
      } catch (error) {
        failed(error);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  });
}

export async function scan(root: string): Promise<Copy[]> {
  const found = await Promise.all((Object.keys(SCOPES) as Scope[]).map((scope) => scanned(root, scope)));
  return found.flat();
}
