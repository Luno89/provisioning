import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LABEL = 'koala.throwaway-of';

export const throwawayLabel = (pid: number = process.pid): string[] => ['--label', `${LABEL}=${pid}`];

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function sweepThrowaways(): Promise<string[]> {
  const listed = (await run('docker', ['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.Names}} {{.Label "${LABEL}"}}`])).stdout;
  const orphans = listed.split('\n').map((line) => line.trim().split(' ')).filter(([name, pid]) => name && pid && !running(Number(pid))).map(([name]) => name!);
  if (orphans.length) await run('docker', ['rm', '-f', ...orphans]);
  return orphans;
}

export default async function setup(): Promise<void> {
  const removed = await sweepThrowaways();
  if (removed.length) console.log(`removed the throwaway containers of test runs that are gone: ${removed.join(', ')}`);
}
