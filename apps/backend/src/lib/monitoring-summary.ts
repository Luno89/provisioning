export type HealthState = 'ok' | 'warning' | 'down' | 'unreachable' | 'installing';

export const STATE_ORDER: Record<HealthState, number> = { down: 0, unreachable: 1, warning: 2, installing: 3, ok: 4 };

export const NEARLY_FULL = 0.9;
export const MANY_ERRORS = 0.05;

export interface AppNumbers {
  probed?: number | undefined;
  up?: number | undefined;
  responseSeconds?: number | undefined;
  podsRunning?: number | undefined;
  podsBroken?: number | undefined;
  memoryBytes?: number | undefined;
  memoryLimitBytes?: number | undefined;
  cpuCores?: number | undefined;
  cpuLimitCores?: number | undefined;
  volumeShare?: number | undefined;
  requestsPerSecond?: number | undefined;
  errorShare?: number | undefined;
  uptimeDay?: number | undefined;
  uptimeWeek?: number | undefined;
  uptimeKept?: number | undefined;
  restartsDay?: number | undefined;
}

export interface ClusterNumbers {
  nodes?: number | undefined;
  nodesNotReady?: number | undefined;
  cpuShare?: number | undefined;
  memoryShare?: number | undefined;
  diskShare?: number | undefined;
  podsPending?: number | undefined;
  podsBroken?: number | undefined;
}

export interface Verdict {
  state: HealthState;
  reasons: string[];
}

export const share = (part: number | undefined, whole: number | undefined): number | undefined =>
  part === undefined || !whole ? undefined : part / whole;

export const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function seconds(value: number): string {
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(value < 10 ? 1 : 0)} s`;
}

export function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export const isUp = (n: AppNumbers): boolean | undefined => {
  if ((n.probed ?? 0) > 0) return n.up === undefined ? undefined : n.up >= 1;
  if (n.podsRunning === undefined && n.podsBroken === undefined) return undefined;
  return (n.podsRunning ?? 0) > 0 && (n.podsBroken ?? 0) === 0;
};

export function appVerdict(n: AppNumbers, firing: readonly string[]): Verdict {
  const reasons: string[] = [];
  const up = isUp(n);
  if (up === false) reasons.push((n.probed ?? 0) > 0 ? 'it does not answer' : 'nothing of it is running');
  if ((n.podsBroken ?? 0) > 0) reasons.push('a container keeps failing to start');
  const memory = share(n.memoryBytes, n.memoryLimitBytes);
  if (memory !== undefined && memory >= NEARLY_FULL) reasons.push(`memory is at ${percent(memory)} of its limit`);
  const cpu = share(n.cpuCores, n.cpuLimitCores);
  if (cpu !== undefined && cpu >= NEARLY_FULL) reasons.push(`CPU is at ${percent(cpu)} of its limit`);
  if (n.volumeShare !== undefined && n.volumeShare >= NEARLY_FULL) reasons.push(`a volume is ${percent(n.volumeShare)} full`);
  if (n.errorShare !== undefined && n.errorShare >= MANY_ERRORS) reasons.push(`${percent(n.errorShare)} of requests fail`);
  if ((n.restartsDay ?? 0) >= 1) reasons.push(`it restarted ${Math.round(n.restartsDay!)} time${Math.round(n.restartsDay!) === 1 ? '' : 's'} in the last day`);
  reasons.push(...firing.filter((summary) => !reasons.includes(summary)));
  const down = up === false || (n.podsBroken ?? 0) > 0;
  return { state: down ? 'down' : reasons.length > 0 ? 'warning' : 'ok', reasons };
}

export function clusterVerdict(n: ClusterNumbers, firing: readonly string[]): Verdict {
  const reasons: string[] = [];
  if ((n.nodesNotReady ?? 0) > 0) reasons.push(`${n.nodesNotReady} of ${n.nodes ?? '?'} machines are not ready`);
  if (n.diskShare !== undefined && n.diskShare >= NEARLY_FULL) reasons.push(`the disk is ${percent(n.diskShare)} full`);
  if (n.memoryShare !== undefined && n.memoryShare >= NEARLY_FULL) reasons.push(`memory is ${percent(n.memoryShare)} used`);
  if (n.cpuShare !== undefined && n.cpuShare >= NEARLY_FULL) reasons.push(`CPU is ${percent(n.cpuShare)} busy`);
  if ((n.podsBroken ?? 0) > 0) reasons.push(`${n.podsBroken} container${n.podsBroken === 1 ? '' : 's'} keep failing to start`);
  reasons.push(...firing.filter((summary) => !reasons.includes(summary)));
  const down = n.nodes !== undefined && n.nodes > 0 && (n.nodesNotReady ?? 0) >= n.nodes;
  return { state: down ? 'down' : reasons.length > 0 ? 'warning' : 'ok', reasons };
}

export const STATE_WORDS: Record<HealthState, string> = {
  ok: 'healthy',
  warning: 'needs attention',
  down: 'down',
  unreachable: 'cannot be reached',
  installing: 'getting its monitoring',
};

export function appLines(name: string, verdict: Verdict, n: AppNumbers, keptDays: number): string[] {
  const lines = [`${name} is ${STATE_WORDS[verdict.state]}${verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : ''}.`];
  if (verdict.state === 'unreachable' || verdict.state === 'installing') return lines;
  const uptime = [
    n.uptimeDay !== undefined ? `${percent(n.uptimeDay)} over the last day` : undefined,
    n.uptimeWeek !== undefined ? `${percent(n.uptimeWeek)} over the last week` : undefined,
    n.uptimeKept !== undefined ? `${percent(n.uptimeKept)} over the ${keptDays} days kept` : undefined,
  ].filter(Boolean);
  lines.push(uptime.length ? `Up ${uptime.join(', ')}.` : 'It has no probe, so its uptime is not measured; it is judged by whether its containers run.');
  if (n.responseSeconds !== undefined) lines.push(`It answers in ${seconds(n.responseSeconds)}.`);
  if (n.requestsPerSecond !== undefined) {
    lines.push(`It serves ${n.requestsPerSecond < 0.1 ? 'under 0.1' : n.requestsPerSecond.toFixed(1)} requests a second${n.errorShare !== undefined ? `, ${percent(n.errorShare)} of them failing` : ''}.`);
  } else {
    lines.push('Its requests are not counted on this cluster yet.');
  }
  const memory = share(n.memoryBytes, n.memoryLimitBytes);
  if (n.memoryBytes !== undefined) lines.push(`Memory: ${bytes(n.memoryBytes)}${memory !== undefined ? ` (${percent(memory)} of its ${bytes(n.memoryLimitBytes!)} limit)` : ', with no limit set'}.`);
  const cpu = share(n.cpuCores, n.cpuLimitCores);
  if (n.cpuCores !== undefined) lines.push(`CPU: ${n.cpuCores.toFixed(2)} cores${cpu !== undefined ? ` (${percent(cpu)} of its limit)` : ''}.`);
  if (n.volumeShare !== undefined) lines.push(`Its fullest volume is ${percent(n.volumeShare)} full.`);
  if (n.restartsDay !== undefined) lines.push(`Restarts in the last day: ${Math.round(n.restartsDay)}.`);
  return lines;
}

export function clusterLines(name: string, verdict: Verdict, n: ClusterNumbers): string[] {
  const lines = [`${name} is ${STATE_WORDS[verdict.state]}${verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : ''}.`];
  if (verdict.state === 'unreachable' || verdict.state === 'installing') return lines;
  if (n.nodes !== undefined) lines.push(`${n.nodes} machine${n.nodes === 1 ? '' : 's'}${n.nodesNotReady ? `, ${n.nodesNotReady} not ready` : ''}.`);
  const used = [
    n.cpuShare !== undefined ? `CPU ${percent(n.cpuShare)}` : undefined,
    n.memoryShare !== undefined ? `memory ${percent(n.memoryShare)}` : undefined,
    n.diskShare !== undefined ? `disk ${percent(n.diskShare)}` : undefined,
  ].filter(Boolean);
  if (used.length) lines.push(`In use: ${used.join(', ')}.`);
  if (n.podsPending) lines.push(`${n.podsPending} pod${n.podsPending === 1 ? ' is' : 's are'} not running.`);
  return lines;
}

export const worstFirst = <T extends { state: HealthState; name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
