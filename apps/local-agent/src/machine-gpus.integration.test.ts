import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCommands } from '@koala/provision';
import { containersOn, throwawayLabel } from '@koala/provision/testing';

const containers = containersOn(localCommands(process.env));
const REPO = path.resolve(import.meta.dirname, '../../..');
const pins = JSON.parse(readFileSync(path.join(REPO, 'dependencies.pins.json'), 'utf8')) as { components: { kind: string; name: string; version: string }[] };
const NODE_IMAGE = `node:${pins.components.find((pin) => pin.kind === 'image' && pin.name === 'node')!.version}`;
const READER = path.join(REPO, 'apps/local-agent/src/testing/read-gpus.ts');
const TSX = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
const TWO_CARDS = 'printf "NVIDIA GeForce RTX 3090, 24576\\nNVIDIA GeForce RTX 3090, 24576\\n"';
const card = (slot: string, driver: string): string => `Slot:\t${slot}\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nDriver:\t${driver}\nModule:\tnouveau\nModule:\tnvidia\n`;
const TWO_CARDS_ON_PCI = `${card('01:00.0', 'nvidia')}\n${card('06:00.0', 'nvidia')}`;

const started: string[] = [];
afterEach(async () => {
  for (const name of started.splice(0)) await containers.remove(name);
});

async function machine(nvidiaSmi: string | undefined, cdi: boolean, runtime = true, lspci = TWO_CARDS_ON_PCI): Promise<unknown> {
  const name = `koala-gpu-read-${randomUUID().slice(0, 8)}`;
  const coverage = process.env.NODE_V8_COVERAGE;
  await containers.run(name, [
    ...throwawayLabel(), '--user', `${process.getuid!()}:${process.getgid!()}`, '-v', `${REPO}:${REPO}:ro`,
    ...(coverage ? ['-v', `${coverage}:${coverage}`, '-e', `NODE_V8_COVERAGE=${coverage}`] : []),
    NODE_IMAGE, 'sleep', 'infinity',
  ]);
  started.push(name);
  const asRoot = (script: string, ...args: string[]) => containers.exec(name, ['sh', '-c', script, ...args], { user: '0' });
  if (nvidiaSmi !== undefined) await asRoot(`printf '#!/bin/sh\\n%s\\n' '${nvidiaSmi}' > /usr/local/bin/nvidia-smi && chmod +x /usr/local/bin/nvidia-smi`);
  await asRoot('printf "%s" "$1" > /usr/local/share/pci-cards && printf \'#!/bin/sh\\n[ "$*" = "-vmmnnk" ] || exit 64\\ncat /usr/local/share/pci-cards\\n\' > /usr/local/bin/lspci && chmod +x /usr/local/bin/lspci', 'sh', lspci);
  if (runtime) await asRoot('printf "#!/bin/sh\\n" > /usr/bin/nvidia-container-runtime && chmod +x /usr/bin/nvidia-container-runtime');
  if (cdi) await asRoot('printf "#!/bin/sh\\n" > /usr/bin/nvidia-cdi-hook && chmod +x /usr/bin/nvidia-cdi-hook');
  const stdout = await containers.exec(name, ['node', TSX, READER], { env: { HOME: '/tmp' } });
  return JSON.parse(stdout.split('\n').at(-1)!);
}

describe('the GPUs a machine reports, read by the agent on a machine of its own', () => {
  it('reports two NVIDIA cards as usable once NVIDIA\'s CDI hook and its container runtime are installed, and not usable with only one of them', async () => {
    expect(await machine(TWO_CARDS, true)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], problems: [], withoutDriver: [] });
    expect(await machine(TWO_CARDS, false)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: false }], problems: [], withoutDriver: [] });
    expect(await machine(TWO_CARDS, true, false)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: false }], problems: [], withoutDriver: [] });
  });

  it('says the NVIDIA driver needs fixing when nvidia-smi is there but does not answer, rather than reporting no GPU', async () => {
    const report = await machine('echo "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver" >&2; exit 9', true) as { gpus: unknown[]; problems: string[] };
    expect(report.gpus).toEqual([]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/^nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: /);
  });

  it('reports an NVIDIA card whose driver is not installed, as lspci sees it bound to nouveau, with no nvidia-smi', async () => {
    expect(await machine(undefined, false, false, card('01:00.0', 'nouveau'))).toEqual({ gpus: [], problems: [], withoutDriver: [{ vendor: 'nvidia', device: 'GA102 [GeForce RTX 3090]', count: 1 }] });
  });
});
