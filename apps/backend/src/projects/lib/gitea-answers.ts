export interface GiteaPull {
  number: number;
  title: string;
  head: string;
  base: string;
  state: string;
  merged: boolean;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const refOf = (value: unknown): string => textOf(recordOf(value)?.ref);

export function nodePortOf(service: unknown, portName: string): number | undefined {
  const ports = recordOf(recordOf(service)?.spec)?.ports;
  if (!Array.isArray(ports)) return undefined;
  const listed = ports.map(recordOf).filter((port) => port !== undefined);
  const port = listed.find((entry) => entry.name === portName)?.nodePort ?? listed[0]?.nodePort;
  return typeof port === 'number' && port > 0 ? port : undefined;
}

export function pullsFrom(body: unknown): GiteaPull[] {
  if (!Array.isArray(body)) throw new Error('Gitea answered a list of pull requests with something that is not a list');
  return body.flatMap((entry) => {
    const pull = recordOf(entry);
    if (!pull || typeof pull.number !== 'number') return [];
    return [{
      number: pull.number,
      title: textOf(pull.title),
      head: refOf(pull.head),
      base: refOf(pull.base),
      state: textOf(pull.state),
      merged: pull.merged === true,
    }];
  });
}

export function pullBetween(pulls: readonly GiteaPull[], head: string, base: string): number | undefined {
  return pulls.find((pull) => pull.head === head && pull.base === base)?.number;
}
