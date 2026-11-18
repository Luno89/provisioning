import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '../../..');
const pins = JSON.parse(readFileSync(path.join(REPO, 'dependencies.pins.json'), 'utf8')) as { components: { kind: string; name: string; version: string }[] };
const NODE_IMAGE = `node:${pins.components.find((pin) => pin.kind === 'image' && pin.name === 'node')!.version}`;
const READER = path.join(REPO, 'apps/local-agent/src/testing/read-gpus.ts');
const TSX = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
const TWO_CARDS = 'printf "NVIDIA GeForce RTX 3090, 24576\\nNVIDIA GeForce RTX 3090, 24576\\n"';

const started: string[] = [];
afterEach(async () => {
  for (const name of started.splice(0)) await run('docker', ['rm', '-f', name]);
});

async function machine(nvidiaSmi: string, cdi: boolean, runtime = true): Promise<unknown> {
  const name = `koala-gpu-read-${randomUUID().slice(0, 8)}`;
  const coverage = process.env.NODE_V8_COVERAGE;
  await run('docker', [
    'run', '-d', '--name', name, ...throwawayLabel(), '--user', `${process.getuid!()}:${process.getgid!()}`, '-v', `${REPO}:${REPO}:ro`,
    ...(coverage ? ['-v', `${coverage}:${coverage}`, '-e', `NODE_V8_COVERAGE=${coverage}`] : []),
    NODE_IMAGE, 'sleep', 'infinity',
  ]);
  started.push(name);
  const asRoot = (script: string) => run('docker', ['exec', '--user', '0', name, 'sh', '-c', script]);
  await asRoot(`printf '#!/bin/sh\\n%s\\n' '${nvidiaSmi}' > /usr/local/bin/nvidia-smi && chmod +x /usr/local/bin/nvidia-smi`);
  if (runtime) await asRoot('printf "#!/bin/sh\\n" > /usr/bin/nvidia-container-runtime && chmod +x /usr/bin/nvidia-container-runtime');
  if (cdi) await asRoot('printf "#!/bin/sh\\n" > /usr/bin/nvidia-cdi-hook && chmod +x /usr/bin/nvidia-cdi-hook');
  const { stdout } = await run('docker', ['exec', '-e', 'HOME=/tmp', name, 'node', TSX, READER], { maxBuffer: 1 << 20 });
  return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

describe('the GPUs a machine reports, read by the agent on a machine of its own', () => {
  it('reports two NVIDIA cards as usable once NVIDIA\'s CDI hook and its container runtime are installed, and not usable with only one of them', async () => {
    expect(await machine(TWO_CARDS, true)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], problems: [] });
    expect(await machine(TWO_CARDS, false)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: false }], problems: [] });
    expect(await machine(TWO_CARDS, true, false)).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: false }], problems: [] });
  });

  it('says the NVIDIA driver needs fixing when nvidia-smi is there but does not answer, rather than reporting no GPU', async () => {
    const report = await machine('echo "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver" >&2; exit 9', true) as { gpus: unknown[]; problems: string[] };
    expect(report.gpus).toEqual([]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/^nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: /);
  });
});
