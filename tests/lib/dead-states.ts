import { localCommands } from '@koala/provision';
import { containersOn } from '@koala/provision/testing';

export const hostContainers = containersOn(localCommands(process.env));

export async function containerNotRunning(name: string): Promise<string | undefined> {
  const inspected = await hostContainers.status(name);
  if (inspected === undefined) return `the container ${name} is gone`;
  const { state: status, code } = inspected;
  if (status === 'running' || status === 'created' || status === 'restarting') return undefined;
  const logs = await hostContainers.logs(name, 15).catch(() => '');
  return `the container ${name} is ${status} (exit code ${code})${logs ? `, its last lines:\n${logs}` : ''}`;
}

export async function runEndedBadlyOver(get: (path: string) => Promise<Response>, runId: string): Promise<string | undefined> {
  const { endings } = await (await get(`/api/engine/runs/endings?ids=${runId}`)).json() as { endings: { runId: string; ended?: { how: string; reason?: string } }[] };
  const ended = endings.find((entry) => entry.runId === runId)?.ended;
  return ended && ended.how !== 'finished' ? `the run ${ended.how}${ended.reason ? `: ${ended.reason}` : ''}` : undefined;
}

export async function startedContainerStopped(names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const inspected = await hostContainers.status(name);
    if (inspected === undefined) continue;
    const { state: status, code } = inspected;
    if (status === 'exited' || status === 'dead') {
      const logs = await hostContainers.logs(name, 15).catch(() => '');
      return `the container ${name} is ${status} (exit code ${code})${logs ? `, its last lines:\n${logs}` : ''}`;
    }
  }
  return undefined;
}
