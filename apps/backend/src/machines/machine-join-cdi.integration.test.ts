import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { excerptEnv, scriptExcerpt } from '../../../../tests/coupling/shell-trace.js';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const JOIN = path.join(REPO, 'scripts/machine/machine.sh');
const SETTINGS = ['NVIDIA_TOOLKIT_VERSION', 'NVIDIA_REPO', 'NVIDIA_CDI_MARKER'].map((name) => {
  const line = readFileSync(JOIN, 'utf8').split('\n').find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`machine.sh names no ${name}`);
  return line;
});

interface Machine { ids?: string; nvidiaSmi?: boolean; hook?: boolean; answer?: 'yes' | 'no'; keyPinned?: boolean }

function join(machine: Machine): { said: string; sudo: string[]; fetched: boolean } {
  const dir = mkdtempSync(path.join(tmpdir(), 'koala-join-cdi-'));
  const bin = path.join(dir, 'bin');
  const sudoLog = path.join(dir, 'sudo.log');
  const curlLog = path.join(dir, 'curl.log');
  const key = path.join(dir, 'gpgkey');
  writeFileSync(key, '-----BEGIN PGP PUBLIC KEY BLOCK-----\nstand-in\n-----END PGP PUBLIC KEY BLOCK-----\n');
  const keySha = createHash('sha256').update(readFileSync(key)).digest('hex');
  const hook = path.join(dir, 'nvidia-cdi-hook');
  const tool = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  spawnSync('mkdir', ['-p', bin]);
  tool('sudo', `printf '%s\\n' "$*" >> '${sudoLog}'\n[ "$1" = tee ] && sed 's/^/  > /' >> '${sudoLog}'\nexit 0`);
  tool('curl', `printf '%s\\n' "$*" >> '${curlLog}'\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp '${key}' "$2"; shift; done`);
  if (machine.nvidiaSmi !== false) tool('nvidia-smi', 'exit 0');
  if (machine.hook) { writeFileSync(hook, '#!/bin/sh\n'); chmodSync(hook, 0o755); }
  const then = [
    ...SETTINGS,
    `NVIDIA_KEY_SHA256=${machine.keyPinned === false ? '0'.repeat(64) : keySha}`,
    `NVIDIA_CDI_HOOK='${hook}'`,
    'die() { echo "refused: $1"; exit 1; }',
    'ok() { echo "ok: $1"; }',
    `ask() { echo "asked: $1"; [ '${machine.answer ?? 'yes'}' = yes ]; }`,
    `have() { [ -x '${bin}'/"$1" ]; }`,
    'sha256_of() { sha256sum "$1" | cut -d" " -f1; }',
    `os_ids() { echo '${machine.ids ?? 'ubuntu debian'}'; }`,
    'offer_nvidia_cdi',
  ].join('\n');
  const run = spawnSync('sh', ['-c', scriptExcerpt(JOIN, ['package_family', 'install_nvidia_cdi', 'offer_nvidia_cdi'], then)], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...excerptEnv() } });
  const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  return { said: `${run.stdout}${run.stderr}`, sudo: read(sudoLog).split('\n').filter(Boolean), fetched: read(curlLog) !== '' };
}

describe('the join offering NVIDIA\'s CDI support on a machine with an NVIDIA GPU', () => {
  it('on Debian or Ubuntu, adds NVIDIA\'s own repository under the key Koala pins and installs the pinned base package, then keeps its CDI spec fresh', () => {
    const { said, sudo } = join({ ids: 'ubuntu debian' });
    expect(said).toMatch(/asked: This machine has an NVIDIA GPU\. Install NVIDIA's CDI support \(nvidia-container-toolkit-base 1\.20\.1-1, from NVIDIA's own repository\)/);
    expect(sudo).toEqual([
      expect.stringMatching(/^install -m 644 \S+ \/usr\/share\/keyrings\/koala-nvidia-container-toolkit\.asc$/) as unknown,
      'tee /etc/apt/sources.list.d/koala-nvidia-container-toolkit.list',
      '  > deb [signed-by=/usr/share/keyrings/koala-nvidia-container-toolkit.asc] https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /',
      'apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0',
      'apt-get install -y nvidia-container-toolkit-base=1.20.1-1',
      'systemctl enable --now nvidia-cdi-refresh.path',
      'systemctl start nvidia-cdi-refresh.service',
      'tee /etc/koala/nvidia-cdi',
      '  > apt',
    ]);
    expect(said).toMatch(/ok: NVIDIA's CDI support 1\.20\.1-1 installed from NVIDIA's own repository/);
  });

  it('on Fedora or RHEL, adds NVIDIA\'s own repository with the pinned key and installs the pinned base package', () => {
    const { sudo } = join({ ids: 'fedora ' });
    expect(sudo[0]).toMatch(/^install -m 644 \S+ \/etc\/pki\/rpm-gpg\/KOALA-NVIDIA-CONTAINER-TOOLKIT$/);
    expect(sudo.slice(1, 9)).toEqual([
      'tee /etc/yum.repos.d/koala-nvidia-container-toolkit.repo',
      '  > [koala-nvidia-container-toolkit]',
      '  > name=NVIDIA Container Toolkit, added by Koala',
      '  > baseurl=https://nvidia.github.io/libnvidia-container/stable/rpm/$basearch',
      '  > repo_gpgcheck=1',
      '  > gpgcheck=0',
      '  > enabled=1',
      '  > gpgkey=file:///etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT',
    ]);
    expect(sudo).toContain('dnf install -y nvidia-container-toolkit-base-1.20.1-1');
    expect(sudo.slice(-2)).toEqual(['tee /etc/koala/nvidia-cdi', '  > dnf']);
  });

  it('installs nothing, saying so, when the key it downloads is not the one Koala pins', () => {
    const { said, sudo } = join({ keyPinned: false });
    expect(said).toMatch(/refused: NVIDIA's package signing key downloaded is not the one Koala pins \(its sha256 differs\); nothing was installed/);
    expect(sudo).toEqual([]);
  });

  it('says how to install it by hand, and installs nothing, on a system NVIDIA\'s repository does not serve', () => {
    const { said, sudo, fetched } = join({ ids: 'arch ' });
    expect(said).toMatch(/NVIDIA's CDI support is not offered on this system, so its GPUs are not used\. Install nvidia-container-toolkit-base 1\.20\.1-1 as https:\/\/docs\.nvidia\.com\/.+ says, enable nvidia-cdi-refresh\.path, then run this command again\./);
    expect(sudo).toEqual([]);
    expect(fetched).toBe(false);
  });

  it('only notices NVIDIA\'s CDI support the person already has, and installs nothing', () => {
    const { said, sudo, fetched } = join({ hook: true });
    expect(said).toMatch(/ok: NVIDIA's CDI support is already installed here; Koala uses it as it is/);
    expect(said).not.toMatch(/asked:/);
    expect(sudo).toEqual([]);
    expect(fetched).toBe(false);
  });

  it('installs nothing on a machine without an NVIDIA GPU, and nothing when the person declines', () => {
    expect(join({ nvidiaSmi: false })).toEqual({ said: '', sudo: [], fetched: false });
    const declined = join({ answer: 'no' });
    expect(declined.said).toMatch(/without it Koala runs apps here on CPU only; run this command again to add it/);
    expect(declined.sudo).toEqual([]);
  });
});
