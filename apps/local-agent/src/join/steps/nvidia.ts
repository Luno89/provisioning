import path from 'node:path';
import type { Progress, Step, StepState } from '@koala/provision';
import { putRootFile, type JoinContext } from '../context.js';
import { NVIDIA_CDI_MARKER } from '../k3s-files.js';

export const NVIDIA_CDI_HOOK = '/usr/bin/nvidia-cdi-hook';
export const NVIDIA_RUNTIME = '/usr/bin/nvidia-container-runtime';
const PACKAGES = ['nvidia-container-toolkit', 'nvidia-container-toolkit-base', 'libnvidia-container-tools', 'libnvidia-container1'];
const APT_KEY = '/usr/share/keyrings/koala-nvidia-container-toolkit.asc';
const APT_LIST = '/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list';
const RPM_KEY = '/etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT';
const RPM_REPO = '/etc/yum.repos.d/koala-nvidia-container-toolkit.repo';

export type PackageFamily = 'apt' | 'dnf' | 'none';

const APT_IDS = new Set(['debian', 'ubuntu']);
const DNF_IDS = new Set(['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'amzn']);

export function packageFamilyOf(osRelease: string | undefined): PackageFamily {
  if (osRelease === undefined) return 'none';
  const field = (name: string): string => osRelease.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '') ?? '';
  const ids = `${field('ID')} ${field('ID_LIKE')}`.split(/\s+/).filter(Boolean);
  if (ids.some((id) => APT_IDS.has(id))) return 'apt';
  if (ids.some((id) => DNF_IDS.has(id))) return 'dnf';
  return 'none';
}

export const packageFamily = async (ctx: JoinContext): Promise<PackageFamily> => packageFamilyOf(await ctx.host.read('/etc/os-release'));

export const manualCdi = (version: string): string =>
  `NVIDIA's CDI support is not offered on this system, so its GPUs are not used. Install nvidia-container-toolkit ${version} as https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html says, enable nvidia-cdi-refresh.path, then run this command again.`;

export async function cdiState(ctx: JoinContext): Promise<StepState> {
  for (const file of [NVIDIA_CDI_HOOK, NVIDIA_RUNTIME]) if (!await ctx.host.executable(file)) return { done: false, why: `${file} is not on this machine` };
  return { done: true };
}

async function installCdi(ctx: JoinContext, progress: Progress): Promise<void> {
  const { nvidia } = ctx.pins;
  const family = await packageFamily(ctx);
  if (family === 'none') throw new Error(manualCdi(nvidia.version));
  const scratch = await ctx.host.scratch();
  try {
    const key = path.join(scratch.dir, 'gpgkey');
    await ctx.host.download('NVIDIA\'s package signing key', `${nvidia.repo}/gpgkey`, key, nvidia.keySha256);
    const sudo = (command: string, args: string[]) => ctx.commands.run({ command, args, sudo: true }, progress);
    if (family === 'apt') {
      await sudo('install', ['-D', '-m', '644', key, ctx.host.at(APT_KEY)]);
      await putRootFile(ctx, APT_LIST, `deb [signed-by=${APT_KEY}] ${nvidia.repo}/stable/deb/$(ARCH) /\n`, '644', progress);
      await sudo('apt-get', ['update', '-o', `Dir::Etc::sourcelist=${APT_LIST}`, '-o', 'Dir::Etc::sourceparts=-', '-o', 'APT::Get::List-Cleanup=0']);
      await sudo('apt-get', ['install', '-y', ...PACKAGES.map((name) => `${name}=${nvidia.version}`)]);
    } else {
      await sudo('install', ['-D', '-m', '644', key, ctx.host.at(RPM_KEY)]);
      await putRootFile(ctx, RPM_REPO, `[koala-nvidia-container-toolkit]\nname=NVIDIA Container Toolkit, added by Koala\nbaseurl=${nvidia.repo}/stable/rpm/$basearch\nrepo_gpgcheck=1\ngpgcheck=0\nenabled=1\ngpgkey=file://${RPM_KEY}\n`, '644', progress);
      await sudo('dnf', ['install', '-y', ...PACKAGES.map((name) => `${name}-${nvidia.version}`)]);
    }
    await sudo('systemctl', ['enable', '--now', 'nvidia-cdi-refresh.path']);
    await sudo('systemctl', ['start', 'nvidia-cdi-refresh.service']);
    await putRootFile(ctx, NVIDIA_CDI_MARKER, `${family}\n`, '644', progress);
  } finally {
    await scratch.remove();
  }
  progress.line(`NVIDIA's CDI support ${nvidia.version} installed from NVIDIA's own repository; apps here can be given this machine's NVIDIA GPUs`);
}

export const nvidiaCdiStep = (version: string): Step<JoinContext> => ({
  id: 'nvidia-cdi',
  title: `Installing NVIDIA's CDI support (nvidia-container-toolkit ${version}), so apps here can use this machine's NVIDIA GPU`,
  check: cdiState,
  apply: installCdi,
});
