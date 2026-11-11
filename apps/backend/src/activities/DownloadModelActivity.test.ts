import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, Reach } from '../infrastructure/index.js';
import { DownloadModelActivity } from './DownloadModelActivity.js';

const DESK: Reach = { clusterId: 'machine-desk', kind: 'koala' } as Reach;
let access: ReturnType<typeof mock<ClusterAccess>>;
let applied: Record<string, unknown>[];
let said: (readonly string[])[];

beforeEach(() => {
  access = mock<ClusterAccess>();
  applied = [];
  said = [];
  access.apply.mockImplementation(async (_target, manifest) => { applied.push(JSON.parse(manifest) as Record<string, unknown>); return ''; });
  access.kubectl.mockImplementation(async (_target, args) => {
    said.push(args);
    if (args.includes('jsonpath={.status.succeeded}|{.status.failed}')) return '1|';
    if (args.includes('logs')) return '2 files, 0.0 GB\ncomplete';
    return '';
  });
});

const args = { clusterId: 'machine-desk', reach: DESK, image: 'vllm/vllm-openai:v0.7.2', modelRepo: 'acme/tiny', cacheHostPath: '/var/lib/rancher/vllm-model-cache' };

describe('downloading a model on the machine that runs it', () => {
  it('makes Koala\'s models namespace and runs the job there, on the cluster it was handed', async () => {
    expect(await DownloadModelActivity(args, { access })).toEqual({ skipped: false, modelDir: '/var/lib/rancher/vllm-model-cache/acme-tiny' });
    expect(applied.map((manifest) => manifest.kind)).toEqual(['Namespace', 'Job']);
    expect(access.apply.mock.calls.every(([target]) => target === DESK)).toBe(true);
    expect(JSON.stringify(applied[1])).toContain('"image":"vllm/vllm-openai:v0.7.2"');
  });

  it('hands a token through a Secret the job reads, removed once the job ends', async () => {
    await DownloadModelActivity({ ...args, hfToken: 'hf_gated' }, { access });
    expect(applied.map((manifest) => manifest.kind)).toEqual(['Namespace', 'Secret', 'Job']);
    expect(JSON.stringify(applied[2])).not.toContain('hf_gated');
    expect(said.some((call) => call.includes('delete') && call.includes('secret'))).toBe(true);
  });

  it('says the model was already on the machine when the job found it there', async () => {
    access.kubectl.mockImplementation(async (_target, argv) => (argv.includes('logs') ? 'already on this machine' : argv.includes('jsonpath={.status.succeeded}|{.status.failed}') ? '1|' : ''));
    expect(await DownloadModelActivity(args, { access })).toMatchObject({ skipped: true });
  });
});
