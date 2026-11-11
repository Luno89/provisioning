import type { ClusterAccess, Reach } from '../index.js';

export const STAND_IN_IMAGE = 'python:3.12-slim';

const SERVING = [
  'set -e',
  'mkdir -p api/models/acme/tiny/tree api/models/acme/empty/tree api/models/acme/noconfig/tree acme/tiny/resolve/main acme/noconfig/resolve/main',
  'echo \'[{"type":"file","path":"config.json","size":2},{"type":"file","path":"weights.bin","size":5}]\' > api/models/acme/tiny/tree/main',
  'echo \'[]\' > api/models/acme/empty/tree/main',
  'echo \'[{"type":"file","path":"README.md","size":3}]\' > api/models/acme/noconfig/tree/main',
  'echo \'{}\' > acme/tiny/resolve/main/config.json',
  'printf hello > acme/tiny/resolve/main/weights.bin',
  'echo hi > acme/noconfig/resolve/main/README.md',
  'exec python3 -m http.server 8080',
].join('\n');

export interface HuggingFaceStandIn {
  endpoint: string;
  stop(): Promise<void>;
}

export async function startHuggingFaceStandIn(access: Pick<ClusterAccess, 'kubectl' | 'apply'>, reach: Reach): Promise<HuggingFaceStandIn> {
  const namespace = `hf-stand-in-${Math.random().toString(36).slice(2, 8)}`;
  await access.kubectl(reach, ['create', 'namespace', namespace]);
  await access.apply(reach, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'hf', namespace, labels: { app: 'hf' } }, spec: { containers: [{ name: 'hf', image: STAND_IN_IMAGE, command: ['sh', '-c', `mkdir -p /srv && cd /srv && ${SERVING}`], ports: [{ containerPort: 8080 }], readinessProbe: { tcpSocket: { port: 8080 } } }] } }));
  await access.apply(reach, JSON.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'hf', namespace }, spec: { selector: { app: 'hf' }, ports: [{ port: 8080 }] } }));
  await access.kubectl(reach, ['wait', '-n', namespace, '--for=condition=Ready', 'pod/hf', '--timeout=720h']);
  const endpoint = `http://hf.${namespace}.svc.cluster.local:8080`;
  const answersByName = `import urllib.request; urllib.request.urlopen(${JSON.stringify(`${endpoint}/api/models/acme/tiny/tree/main`)}).read()`;
  for (;;) {
    try {
      await access.kubectl(reach, ['exec', '-n', namespace, 'hf', '--', 'python3', '-c', answersByName]);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  return {
    endpoint,
    stop: async () => { await access.kubectl(reach, ['delete', 'namespace', namespace, '--wait=false', '--ignore-not-found']); },
  };
}
