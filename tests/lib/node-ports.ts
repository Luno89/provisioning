import { connect } from 'node:net';

export interface NodePort {
  service: string;
  port: number;
}

interface ServiceList {
  items?: { metadata?: { namespace?: string; name?: string }; spec?: { type?: string; ports?: { nodePort?: number; protocol?: string }[] } }[];
}

export function nodePortsOf(services: unknown): NodePort[] {
  const found: NodePort[] = [];
  for (const item of (services as ServiceList)?.items ?? []) {
    if (item.spec?.type !== 'NodePort' && item.spec?.type !== 'LoadBalancer') continue;
    for (const port of item.spec.ports ?? []) {
      if (port.nodePort && (port.protocol ?? 'TCP') === 'TCP') found.push({ service: `${item.metadata?.namespace}/${item.metadata?.name}`, port: port.nodePort });
    }
  }
  return found.sort((a, b) => a.port - b.port);
}

export const PROBE_WAIT_SECONDS = 4;

const PROBE_PY = [
  'import socket, sys',
  'address = sys.argv[1]',
  'for port in sys.argv[2:]:',
  '    said = 0',
  '    try:',
  `        s = socket.create_connection((address, int(port)), ${PROBE_WAIT_SECONDS})`,
  `        s.settimeout(${PROBE_WAIT_SECONDS})`,
  '        s.sendall(b"GET / HTTP/1.0\\r\\nHost: probe\\r\\n\\r\\n")',
  '        said = len(s.recv(64))',
  '        s.close()',
  '    except Exception:',
  '        pass',
  '    print(port, said)',
].join('\n');

export const probeCommand = (address: string, ports: readonly number[]): string =>
  `echo ${Buffer.from(PROBE_PY).toString('base64')} | base64 -d > /tmp/node-port-probe.py && python3 /tmp/node-port-probe.py ${address} ${ports.join(' ')}`;

export function answeringIn(output: string): number[] {
  return output.split('\n')
    .map((line) => /^(\d+) (\d+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match) && Number(match![2]) > 0)
    .map((match) => Number(match[1]));
}

export function answersThrough(hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: hostPort });
    const done = (said: boolean) => { socket.destroy(); resolve(said); };
    socket.setTimeout(PROBE_WAIT_SECONDS * 1000, () => done(false));
    socket.on('connect', () => socket.write('GET / HTTP/1.0\r\nHost: probe\r\n\r\n'));
    socket.on('data', () => done(true));
    socket.on('end', () => done(false));
    socket.on('error', () => done(false));
  });
}
