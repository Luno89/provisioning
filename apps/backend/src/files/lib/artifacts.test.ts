import { describe, it, expect } from 'vitest';
import { failureArtifacts, minioEndpoint, minioOf, withinBudget, chunksOf } from './artifacts.js';

const minio = (over: Record<string, unknown> = {}) => ({ id: 'm1', name: 'Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootPassword: 'pw', ...over });

describe('finding the owner\'s MinIO', () => {
  it('takes only a running MinIO of theirs whose keys are stored', () => {
    expect(minioOf([minio({ ownerId: 'al' }), minio({ status: 'deploying' }), minio({ minioRootPassword: undefined }), minio({ appType: 'qdrant' })], 'bo')).toBeUndefined();
    expect(minioOf([minio({ ownerId: 'al' }), minio({ id: 'm2' })], 'bo')?.id).toBe('m2');
  });
});

describe('where Koala reaches a MinIO', () => {
  const ports = { spec: { ports: [{ name: 'console', port: 9001, nodePort: 30901 }, { name: 's3', port: 9000, nodePort: 30900 }] } };

  it('is its service name on Koala\'s own cluster, on the S3 port', () => {
    expect(minioEndpoint(ports, 'store-m10000', { kind: 'koala' })).toEqual({ host: 'minio.store-m10000.svc.cluster.local', port: 9000 });
  });

  it('is the machine\'s mesh address and the S3 node port on another of the person\'s machines', () => {
    expect(minioEndpoint(ports, 'store-m10000', { kind: 'machine', clusterId: 'machine-desk', meshIp: '100.64.0.7' })).toEqual({ host: '100.64.0.7', port: 30900 });
  });

  it('is refused, saying why, with no S3 port, no mesh address or no node port', () => {
    expect(() => minioEndpoint({ spec: { ports: [{ name: 'console', port: 9001 }] } }, 'store', { kind: 'koala' })).toThrow('MinIO in store serves no S3 port');
    expect(() => minioEndpoint(ports, 'store', { kind: 'machine', clusterId: 'machine-desk' })).toThrow('machine-desk has no mesh address');
    expect(() => minioEndpoint({ spec: { ports: [{ name: 's3', port: 9000 }] } }, 'store', { kind: 'machine', clusterId: 'machine-desk', meshIp: '100.64.0.7' })).toThrow('has no node port');
  });
});

describe('what counts as a failure artifact', () => {
  it('is a screenshot, video or trace Playwright left for a failed test', () => {
    expect(failureArtifacts([
      'e2e-results/artifacts/signs-in-chromium/test-failed-1.png',
      'e2e-results/artifacts/signs-in-chromium/trace.zip',
      'e2e-results/artifacts/signs-in-chromium/video.webm',
      'e2e-results/report.json',
      'addons/koala_probe/static/logo.png',
    ])).toEqual([
      'e2e-results/artifacts/signs-in-chromium/test-failed-1.png',
      'e2e-results/artifacts/signs-in-chromium/trace.zip',
      'e2e-results/artifacts/signs-in-chromium/video.webm',
    ]);
  });
});

describe('a run\'s budget', () => {
  it('keeps the smallest first so one huge video does not crowd out every screenshot', () => {
    const { kept, dropped } = withinBudget([{ name: 'video', size: 90 }, { name: 'shot', size: 5 }, { name: 'trace', size: 20 }], 0, 30);
    expect(kept.map((f) => f.name)).toEqual(['shot', 'trace']);
    expect(dropped.map((f) => f.name)).toEqual(['video']);
  });

  it('splits bytes into pieces that rejoin exactly', () => {
    const bytes = Buffer.from('abcdefghij');
    expect(Buffer.concat(chunksOf(bytes, 4)).equals(bytes)).toBe(true);
    expect(chunksOf(bytes, 4)).toHaveLength(3);
  });
});

describe('reading failure artifacts back from a workspace', () => {
  it('lists what Playwright left, reads only failure files within budget, and names them by test', async () => {
    const { readFailureArtifacts, artifactLines } = await import('./artifacts.js');
    const ran: string[] = [];
    const workspace = {
      exec: async (command: string) => {
        ran.push(command);
        if (command.startsWith('find')) return { stdout: '4 e2e-results/artifacts/signs-in/test-failed-1.png\n900 e2e-results/artifacts/signs-in/video.webm\n12 e2e-results/artifacts/signs-in/.last-run.json\n', stderr: '', exitCode: 0 };
        return { stdout: Buffer.from('shot').toString('base64'), stderr: '', exitCode: 0 };
      },
    };
    const { files, dropped } = await readFailureArtifacts(workspace, 100);

    expect(files).toEqual([{ name: 'signs-in/test-failed-1.png', bytes: Buffer.from('shot') }]);
    expect(dropped).toEqual(['signs-in/video.webm']);
    expect(ran.filter((command) => command.startsWith('tail'))).toEqual(["tail -c +1 'e2e-results/artifacts/signs-in/test-failed-1.png' | head -c 22000 | base64 -w0"]);
    expect(artifactLines([{ id: 'a1', name: files[0]!.name }], dropped)).toBe(
      "what the browser left behind:\n- signs-in/test-failed-1.png:\n\n  ![signs-in/test-failed-1.png](/api/artifacts/a1)\n- not kept, over the run's 50 MB: signs-in/video.webm",
    );
    expect(artifactLines([{ id: 'a2', name: 'signs-in/trace.zip' }], [])).toBe(
      'what the browser left behind:\n- [signs-in/trace.zip](/api/artifacts/a2)',
    );
  });
});

describe('reading a file bigger than one command can print', () => {
  it('reads it in pieces that fit under the workspace\'s output cap and puts them back together exactly', async () => {
    const { readFailureArtifacts, READ_PIECE_BYTES } = await import('./artifacts.js');
    const video = Buffer.from(Array.from({ length: READ_PIECE_BYTES * 2 + 500 }, (_, i) => i % 251));
    const ran: string[] = [];
    const workspace = {
      exec: async (command: string) => {
        ran.push(command);
        if (command.startsWith('find')) return { stdout: `${video.length} e2e-results/artifacts/t/video.webm\n`, stderr: '', exitCode: 0 };
        const [, from, count] = /tail -c \+(\d+) .* head -c (\d+)/.exec(command)!;
        const piece = video.subarray(Number(from) - 1, Number(from) - 1 + Number(count)).toString('base64');
        expect(piece.length).toBeLessThan(30_000);
        return { stdout: piece, stderr: '', exitCode: 0 };
      },
    };
    const { files } = await readFailureArtifacts(workspace);
    expect(ran.filter((command) => command.startsWith('tail'))).toHaveLength(3);
    expect(files[0]!.bytes.equals(video)).toBe(true);
  });

  it('refuses a file that comes back a different size than it was listed, rather than keep a broken copy', async () => {
    const { readFailureArtifacts } = await import('./artifacts.js');
    const workspace = {
      exec: async (command: string) => (command.startsWith('find')
        ? { stdout: '30000 e2e-results/artifacts/t/trace.zip\n', stderr: '', exitCode: 0 }
        : { stdout: Buffer.alloc(100).toString('base64'), stderr: '', exitCode: 0 }),
    };
    expect(await readFailureArtifacts(workspace)).toEqual({ files: [], dropped: [], unreadable: ['t/trace.zip'] });
  });
});
