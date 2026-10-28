import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const out = path.resolve(process.argv[2] ?? path.join(app, 'dist'));
const staging = path.join(out, 'machine');
const RUNTIME = ['@temporalio/worker', '@temporalio/activity', '@temporalio/common', 'protobufjs', '@agentclientprotocol/sdk', 'socket.io-client'];

const require = createRequire(path.join(app, 'package.json'));
const versionOf = (name) => {
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    try {
      const manifest = require(path.join(dir, 'package.json'));
      if (manifest.name === name) return manifest.version;
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`could not find the version of ${name}`);
    dir = up;
  }
};

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await build({
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
const own = require(path.join(app, 'package.json'));
await writeFile(path.join(staging, 'package.json'), `${JSON.stringify({
  name: 'koala-machine',
  version: own.version,
  private: true,
  type: 'module',
  main: 'agent.mjs',
  engines: { node: '>=20' },
  dependencies: Object.fromEntries(RUNTIME.map((name) => [name, versionOf(name)])),
}, null, 2)}\n`);
const run = promisify(execFile);
await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: staging });
const tarball = path.join(out, 'machine-agent.tgz');
await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', staging, '.']);
const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
await writeFile(`${tarball}.sha256`, `${sha256}  machine-agent.tgz\n`);
console.log(tarball);
