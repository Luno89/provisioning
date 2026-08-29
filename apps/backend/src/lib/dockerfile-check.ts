
export interface DockerfileProblem {
  line: number;
  problem: string;
  fix: string;
}

interface Instruction { line: number; verb: string; rest: string }

function parse(dockerfile: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = dockerfile.split('\n');
  let buffer = '';
  let startLine = 0;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!buffer) startLine = index + 1;
    if (line.endsWith('\\')) { buffer += `${line.slice(0, -1)} `; continue; }
    buffer += line;
    const match = /^(\w+)\s+([\s\S]*)$/.exec(buffer);
    if (match) out.push({ line: startLine, verb: match[1]!.toUpperCase(), rest: match[2]!.trim() });
    buffer = '';
  }
  return out;
}

function copiedPaths(rest: string): string[] {
  const parts = rest.split(/\s+/).filter((p) => !p.startsWith('--'));
  return parts.slice(0, -1);
}

function isCopied(path: string, copies: string[]): boolean {
  return copies.some((c) => c === '.' || c === './' || c === path || c === `./${path}`
    || (c.endsWith('/') && path.startsWith(c)));
}

export function isIgnored(path: string, dockerignore: string | undefined): boolean {
  if (!dockerignore) return false;

  let ignored = false;
  for (const raw of dockerignore.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/\/$/, '');
    if (!pattern) continue;

    const matches = pattern === path
      || path.startsWith(`${pattern}/`)
      || (pattern.startsWith('*') && path.endsWith(pattern.slice(1)));
    if (matches) ignored = !negated;
  }
  return ignored;
}

export function checkDockerfile(
  dockerfile: string,
  files: string[],
  dockerignore?: string,
  hasDependencies?: boolean,
): DockerfileProblem[] {
  const problems: DockerfileProblem[] = [];
  const instructions = parse(dockerfile);
  const has = (name: string) => files.includes(name);

  let copies: string[] = [];

  for (const ins of instructions) {
    if (ins.verb === 'FROM') { copies = []; continue; }
    if (ins.verb === 'COPY' || ins.verb === 'ADD') {
      if (/--from=/.test(ins.rest) && /node_modules/.test(ins.rest)
          && hasDependencies === false) {
        problems.push({
          line: ins.line,
          problem: 'This copies node_modules from a build stage, but package.json declares no '
            + 'dependencies — so nothing is installed and the directory never exists.',
          fix: 'Drop the build stage and the node_modules copy; a project with no dependencies needs neither.',
        });
      }

      copies.push(...copiedPaths(ins.rest));
      continue;
    }

    if (ins.verb === 'RUN' && /\bnpm\s+ci\b/.test(ins.rest)) {
      if (!has('package-lock.json')) {
        problems.push({
          line: ins.line,
          problem: '`npm ci` needs package-lock.json and the repository does not have one.',
          fix: 'Run `npm install` and commit the lockfile, or use `npm install` in the image instead.',
        });
      } else if (isIgnored('package-lock.json', dockerignore)) {
        problems.push({
          line: ins.line,
          problem: '`npm ci` needs package-lock.json and .dockerignore excludes it from the build context.',
          fix: 'Remove package-lock.json from .dockerignore.',
        });
      } else if (!isCopied('package-lock.json', copies)) {
        problems.push({
          line: ins.line,
          problem: '`npm ci` needs package-lock.json and nothing in this stage has copied it. '
            + `This stage copied: ${copies.join(', ') || 'nothing'}.`,
          fix: 'Copy it before installing, e.g. `COPY package.json package-lock.json ./`.',
        });
      }
    }

    if (ins.verb === 'CMD' || ins.verb === 'ENTRYPOINT') {
      const script = [...ins.rest.matchAll(/["']([^"']+\.(?:js|mjs|cjs|py|sh))["']/g)].map((m) => m[1]!)[0];
      if (script && has(script) && !isCopied(script, copies) && !isIgnored(script, dockerignore)) {
        problems.push({
          line: ins.line,
          problem: `The container runs ${script}, and nothing in this stage copied it.`,
          fix: `Add \`COPY ${script.split('/')[0]}/ ./${script.split('/')[0]}/\` before the ${ins.verb}.`,
        });
      }
    }
  }

  return problems;
}

export function describeDockerfileProblems(problems: DockerfileProblem[]): string {
  if (!problems.length) return '';
  return [
    'This Dockerfile cannot build:',
    ...problems.map((p) => `  line ${p.line}: ${p.problem}\n    fix: ${p.fix}`),
  ].join('\n');
}
