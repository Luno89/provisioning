import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createContainer, destroyContainer } from '../apps/local-agent/src/docker-driver.js';

const run = promisify(execFile);
const LEAF = `live-${Date.now().toString(36)}`;
const PROXY = 'koala-egress-proxy';
const docker = async (...args: string[]) => (await run('docker', args)).stdout.trim();
const inLeaf = async (script: string) => {
  const answer = await run('docker', ['exec', `koala-leaf-${LEAF}`, 'sh', '-c', `${script} 2>&1; echo "exit $?"`]).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }));
  return answer.stdout.trim();
};

let stageCount = 0;
async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  stageCount += 1;
  console.log(`[${stageCount}] ${name}`);
  const value = await work();
  console.log('    ok');
  return value;
}

async function main(): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'machine-container-live-'));
  await chmod(folder, 0o777);
  try {
    await stage('a workspace container starts on a machine in container mode, its only way out the egress proxy', async () => {
      await createContainer({ leafId: LEAF, image: 'busybox:1.37', rootDir: folder, egress: [{ host: 'example.com', ports: [443] }] });
    });
    const proxyIp = await docker('inspect', PROXY, '--format', `{{index .NetworkSettings.Networks "koala-leaf-net-${LEAF}" "IPAddress"}}`);
    assert.ok(proxyIp, 'the proxy is not on the workspace\'s network');

    await stage('the workspace cannot change the proxy\'s allowlist, with no token or a guessed one', async () => {
      const body = JSON.stringify({ containerIp: '0.0.0.0', rules: [{ host: 'evil.example' }] }).replace(/"/g, '\\"');
      const post = (header: string) => inLeaf(`env -u http_proxy -u HTTP_PROXY wget -q -O - ${header} --header='content-type: application/json' --post-data="${body}" http://${proxyIp}:38081/allowlist`);
      const bare = await post('');
      const guessed = await post(`--header='authorization: Bearer ${'0'.repeat(64)}'`);
      console.log(`    no token: ${bare.split('\n').join(' | ')}\n    guessed token: ${guessed.split('\n').join(' | ')}`);
      assert.match(bare, /401/, 'the proxy took a change from the workspace with no token');
      assert.match(guessed, /401/, 'the proxy took a change from the workspace with a guessed token');
    });

    await stage('the workspace reaches only what its allowlist names, through the proxy', async () => {
      const connect = (host: string) => inLeaf(`printf 'CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n' | nc -w 5 ${proxyIp} 38080 | head -1`);
      const refused = await connect('evil.example');
      const allowed = await connect('example.com');
      console.log(`    evil.example: ${refused.split('\n')[0]}\n    example.com: ${allowed.split('\n')[0]}`);
      assert.match(refused, /403/, 'the proxy let the workspace out to a host its allowlist does not name');
      assert.match(allowed, /200 Connection Established/, 'the proxy refused the host the allowlist names');
    });
  } finally {
    await destroyContainer(LEAF);
    await docker('rm', '-f', PROXY).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
  console.log('\npassed');
}

main().then(() => process.exit(0), (err) => {
  console.error(`\nmachine container live — FAIL: ${(err as Error).message}`);
  process.exit(1);
});
