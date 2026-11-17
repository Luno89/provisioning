import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AxiosInstance } from 'axios';

export async function runEndedBadly(http: AxiosInstance, runId: string): Promise<string | undefined> {
  const { endings } = (await http.get('/engine/runs/endings', { params: { ids: runId } })).data as { endings: { runId: string; ended?: { how: string; reason?: string } }[] };
  const ended = endings.find((entry) => entry.runId === runId)?.ended;
  return ended && ended.how !== 'finished' ? `the run ${ended.how}${ended.reason ? `: ${ended.reason}` : ''}` : undefined;
}

export async function checkRunEndedBadly(http: AxiosInstance, id: string): Promise<string | undefined> {
  const run = (await http.get(`/evals/level2/runs/${id}`)).data as { state: string; error?: string };
  return run.state === 'running' || run.state === 'done' ? undefined : `the check run ${run.state}${run.error ? `: ${run.error}` : ''}`;
}

export async function deploymentFailed(http: AxiosInstance, name: string): Promise<string | undefined> {
  const found = ((await http.get('/deployments')).data as { name: string; status: string; error?: string }[]).find((entry) => entry.name === name);
  return found?.status === 'failed' ? `the deployment failed${found.error ? `: ${found.error}` : ''}` : undefined;
}

export async function keeperPaused(http: AxiosInstance): Promise<string | undefined> {
  const { keeper } = (await http.get('/running')).data as { keeper: { paused: boolean } };
  return keeper.paused ? 'the memory keeper is paused, so it will not run' : undefined;
}

const docker = promisify(execFile);

export async function containerNotRunning(name: string): Promise<string | undefined> {
  const inspected = await docker('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name]).then((out) => out.stdout.trim(), () => undefined);
  if (inspected === undefined) return `the container ${name} is gone`;
  const [status, code] = inspected.split(' ');
  if (status === 'running' || status === 'created' || status === 'restarting') return undefined;
  const logs = await docker('docker', ['logs', '--tail', '15', name]).then((out) => `${out.stdout}${out.stderr}`.trim(), () => '');
  return `the container ${name} is ${status} (exit code ${code})${logs ? `, its last lines:\n${logs}` : ''}`;
}

export async function agentWillNotBeReady(http: AxiosInstance, deviceId: string, agentId: string): Promise<string | undefined> {
  const device = ((await http.get('/mesh/local-agents')).data as { id: string; name: string; online: boolean; agents: { id: string; state: string; reason?: string }[] }[]).find((entry) => entry.id === deviceId);
  if (!device) return `the machine ${deviceId} is gone`;
  if (!device.online) return `${device.name} went offline`;
  const found = device.agents.find((entry) => entry.id === agentId);
  return found && (found.state === 'needs-adapter' || found.state === 'not-answering') ? `${agentId} is ${found.state} on ${device.name}${found.reason ? `: ${found.reason}` : ''}` : undefined;
}

export async function runEndedBadlyOver(get: (path: string) => Promise<Response>, runId: string): Promise<string | undefined> {
  const { endings } = await (await get(`/api/engine/runs/endings?ids=${runId}`)).json() as { endings: { runId: string; ended?: { how: string; reason?: string } }[] };
  const ended = endings.find((entry) => entry.runId === runId)?.ended;
  return ended && ended.how !== 'finished' ? `the run ${ended.how}${ended.reason ? `: ${ended.reason}` : ''}` : undefined;
}

export async function startedContainerStopped(names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const inspected = await docker('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name]).then((out) => out.stdout.trim(), () => undefined);
    if (inspected === undefined) continue;
    const [status, code] = inspected.split(' ');
    if (status === 'exited' || status === 'dead') {
      const logs = await docker('docker', ['logs', '--tail', '15', name]).then((out) => `${out.stdout}${out.stderr}`.trim(), () => '');
      return `the container ${name} is ${status} (exit code ${code})${logs ? `, its last lines:\n${logs}` : ''}`;
    }
  }
  return undefined;
}

export async function runEndedAtAll(http: AxiosInstance, runId: string, before: string): Promise<string | undefined> {
  const { endings } = (await http.get('/engine/runs/endings', { params: { ids: runId } })).data as { endings: { runId: string; ended?: { how: string; reason?: string } }[] };
  const ended = endings.find((entry) => entry.runId === runId)?.ended;
  return ended ? `the run ${ended.how}${ended.reason ? ` (${ended.reason})` : ''} ${before}` : undefined;
}
