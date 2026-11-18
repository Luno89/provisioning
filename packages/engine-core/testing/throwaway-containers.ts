import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LABEL = 'koala.throwaway-of';
const CHECKOUT_LABEL = 'koala.throwaway-checkout';
const THIS_CHECKOUT = resolve(import.meta.dirname, '../../..');

export const throwawayLabel = (pid: number = process.pid, checkout: string = THIS_CHECKOUT): string[] => ['--label', `${LABEL}=${pid}`, '--label', `${CHECKOUT_LABEL}=${checkout}`];

export type Docker = (args: string[]) => Promise<unknown>;

const docker: Docker = (args) => run('docker', args);

export async function removeThrowaway(name: string, through: Docker = docker): Promise<void> {
  await through(['stop', '--signal', 'KILL', '--timeout', '-1', name]);
  await through(['rm', '--volumes', name]);
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function sweepThrowaways(checkout: string = THIS_CHECKOUT): Promise<string[]> {
  const listed = (await run('docker', ['ps', '-a', '--filter', `label=${CHECKOUT_LABEL}=${checkout}`, '--format', `{{.Names}} {{.Label "${LABEL}"}}`])).stdout;
  const orphans = listed.split('\n').map((line) => line.trim().split(' ')).filter(([name, pid]) => name && pid && !running(Number(pid))).map(([name]) => name!);
  for (const orphan of orphans) await removeThrowaway(orphan);
  return orphans;
}

export default async function setup(): Promise<void> {
  const removed = await sweepThrowaways();
  if (removed.length) console.log(`removed the throwaway containers of test runs that are gone: ${removed.join(', ')}`);
}
