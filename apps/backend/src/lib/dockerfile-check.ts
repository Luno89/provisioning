/**
 * Reading a Dockerfile for the mistakes that only show up in a build.
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 * A leaf rewrote a working Dockerfile into a multi-stage build:
 *
 *     COPY package.json ./
 *     RUN npm ci --omit=dev
 *
 * `npm ci` requires `package-lock.json`, and only `package.json` was copied. The lockfile was in
 * the repository and not excluded — it was simply never put in the image. Every build failed.
 *
 * The leaf was marked succeeded AND verified, because verification runs `node --test` and the test
 * suite never reads the Dockerfile. So the one artifact the deploy depends on was the one thing
 * nothing checked, and the failure surfaced ninety minutes later as a queue full of retries.
 *
 * ── WHY A STATIC CHECK RATHER THAN A BUILD ──
 * Building would be the real answer and is not available: the sandbox has no image builder, and
 * adding one puts a multi-minute docker build inside every leaf's budget. This reads the file
 * instead. It cannot prove a Dockerfile works — it can only catch the specific ways one is
 * definitely broken, which is worth far more than the nothing it replaces.
 *
 * Everything here is a DEFINITE fault, never a style opinion. A check that fires on something
 * merely unusual would be turned off within a week.
 */

export interface DockerfileProblem {
  line: number;
  problem: string;
  fix: string;
}

interface Instruction { line: number; verb: string; rest: string }

/** Instructions, with continuations joined and comments dropped. */
function parse(dockerfile: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = dockerfile.split('\n');
  let buffer = '';
  let startLine = 0;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!buffer) startLine = index + 1;
    // A trailing backslash continues onto the next line, which is how long RUN commands are
    // written and how a naive line-by-line reader misses half of them.
    if (line.endsWith('\\')) { buffer += `${line.slice(0, -1)} `; continue; }
    buffer += line;
    const match = /^(\w+)\s+([\s\S]*)$/.exec(buffer);
    if (match) out.push({ line: startLine, verb: match[1]!.toUpperCase(), rest: match[2]!.trim() });
    buffer = '';
  }
  return out;
}

/** Paths a COPY brings in, ignoring flags like --from and the destination. */
function copiedPaths(rest: string): string[] {
  const parts = rest.split(/\s+/).filter((p) => !p.startsWith('--'));
  // The last argument is the destination, not a source.
  return parts.slice(0, -1);
}

/** Whether a path is covered by something already copied. `.` and `./` bring everything. */
function isCopied(path: string, copies: string[]): boolean {
  return copies.some((c) => c === '.' || c === './' || c === path || c === `./${path}`
    || (c.endsWith('/') && path.startsWith(c)));
}

/**
 * A `.dockerignore` pattern set, reduced to a predicate.
 *
 * Deliberately simple: exact names, directory prefixes and a leading `*` suffix match. Anything
 * more elaborate is not matched, and the check stays silent rather than guessing — a false
 * "your lockfile is ignored" would send somebody hunting a problem that is not there.
 */
export function isIgnored(path: string, dockerignore: string | undefined): boolean {
  if (!dockerignore) return false;

  /**
   * Last match wins, which is Docker's actual rule and the reason `!` cannot simply be skipped.
   *
   * `*.json` followed by `!package-lock.json` does NOT exclude the lockfile — and reading it as an
   * exclusion would produce a confident, wrong accusation about the one file this check exists to
   * reason about.
   */
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

/**
 * What is definitely wrong with this Dockerfile.
 *
 * `files` is what the repository actually contains, so a check can tell "the lockfile is missing
 * from the image" from "there is no lockfile at all" — different problems needing different fixes.
 */
export function checkDockerfile(
  dockerfile: string,
  files: string[],
  dockerignore?: string,
  /** What package.json declares, so a copy of node_modules can be judged. */
  hasDependencies?: boolean,
): DockerfileProblem[] {
  const problems: DockerfileProblem[] = [];
  const instructions = parse(dockerfile);
  const has = (name: string) => files.includes(name);

  /**
   * Per stage, because a multi-stage build resets the filesystem at every FROM.
   *
   * This is the whole reason the observed bug was invisible to a reader: the `COPY package.json`
   * and the `RUN npm ci` were adjacent and looked complete, and the lockfile that a later stage
   * copied never existed in the stage that needed it.
   */
  let copies: string[] = [];

  for (const ins of instructions) {
    if (ins.verb === 'FROM') { copies = []; continue; }
    if (ins.verb === 'COPY' || ins.verb === 'ADD') {
    /**
     * Copying node_modules out of a stage that installs nothing.
     *
     * `npm ci` on a project with no dependencies creates no node_modules at all, so the copy fails
     * with `lstat /kaniko/0/app/node_modules: no such file or directory` — an error that names a
     * path inside the builder and says nothing about the cause.
     *
     * Observed: an agent asked for a zero-dependency server wrote a textbook multi-stage build for
     * it. Every instruction is individually correct and the whole is unbuildable.
     */
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

    // What the container actually runs has to be in the image.
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

/** One block of text for an agent that has just broken the build, or '' when it is fine. */
export function describeDockerfileProblems(problems: DockerfileProblem[]): string {
  if (!problems.length) return '';
  return [
    'This Dockerfile cannot build:',
    ...problems.map((p) => `  line ${p.line}: ${p.problem}\n    fix: ${p.fix}`),
  ].join('\n');
}
