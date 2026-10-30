import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { RUNTIME } from './machine-runtime.mjs';
import { machineLock } from './machine-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const out = path.resolve(process.argv[2] ?? path.join(app, 'dist'));
const staging = path.join(out, 'machine');

const repo = path.resolve(app, '../..');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await build({
  absWorkingDir: app,
  entryPoints: [path.join(app, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(staging, 'agent.mjs'),
  external: RUNTIME.map((name) => `${name}*`),
  banner: { js: "import { createRequire as __koalaRequire } from 'module'; const require = __koalaRequire(import.meta.url);" },
  logLevel: 'warning',
});
const own = await readJson(path.join(app, 'package.json'));
const engines = { node: '>=20' };
const lock = machineLock(await readJson(path.join(repo, 'package-lock.json')), path.relative(repo, app), RUNTIME, { name: 'koala-machine', version: own.version, engines });
await writeFile(path.join(staging, 'package.json'), `${JSON.stringify({
  name: 'koala-machine',
  version: own.version,
  private: true,
  type: 'module',
  main: 'agent.mjs',
  engines,
  dependencies: lock.packages[''].dependencies,
}, null, 2)}\n`);
await writeFile(path.join(staging, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
const run = promisify(execFile);
const tarball = path.join(out, 'machine-agent.tgz');
const { stdout: archive } = await run('tar', [
  '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=a=rX,u+w', '--format=gnu',
  '-cf', '-', '-C', staging, '.',
], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
const bytes = gzipSync(archive, { level: 9 });
await writeFile(tarball, bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${tarball}.sha256`, `${sha256}  machine-agent.tgz\n`);
console.log(tarball);
