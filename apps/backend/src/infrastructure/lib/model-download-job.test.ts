import { describe, expect, it } from 'vitest';
import { modelDownloadJob, modelJobName, MODEL_DOWNLOADS } from './model-download-job.js';
import { koalaRightsIn } from '../../platform/testing/pod-rights.js';

const job = (extra: Partial<Parameters<typeof modelDownloadJob>[0]> = {}) => modelDownloadJob({
  name: 'model-abc', image: 'vllm/vllm-openai:v0.7.2', repo: 'Qwen/Qwen2.5-0.5B-Instruct', folder: 'qwen-qwen2-5-0-5b-instruct',
  cacheHostPath: '/var/lib/rancher/vllm-model-cache', endpoint: 'https://huggingface.co', ...extra,
});

const container = (manifest: Record<string, unknown>) => (manifest as { spec: { template: { spec: { containers: { env: { name: string; value?: string; valueFrom?: unknown }[]; image: string; command: string[] }[]; volumes: unknown[] } } } }).spec.template.spec;

describe('the job that downloads a model on the machine that runs it', () => {
  it('runs once in the app\'s own image, in Koala\'s models namespace, writing into the machine\'s cache folder', () => {
    const made = job();
    expect(made).toMatchObject({ kind: 'Job', metadata: { name: 'model-abc', namespace: MODEL_DOWNLOADS }, spec: { backoffLimit: 0, template: { spec: { restartPolicy: 'Never' } } } });
    const spec = container(made);
    expect(spec.containers[0]!.image).toBe('vllm/vllm-openai:v0.7.2');
    expect(spec.containers[0]!.command.slice(0, 2)).toEqual(['python3', '-c']);
    expect(spec.volumes).toEqual([{ name: 'cache', hostPath: { path: '/var/lib/rancher/vllm-model-cache', type: 'DirectoryOrCreate' } }]);
    expect(spec.containers[0]!.env).toEqual([
      { name: 'HF_ENDPOINT', value: 'https://huggingface.co' },
      { name: 'REPO', value: 'Qwen/Qwen2.5-0.5B-Instruct' },
      { name: 'REVISION', value: '' },
      { name: 'FOLDER', value: 'qwen-qwen2-5-0-5b-instruct' },
    ]);
  });

  it('reads a token from a Secret, never as a value in the job', () => {
    const env = container(job({ tokenSecret: 'model-abc-token' })).containers[0]!.env;
    expect(env.at(-1)).toEqual({ name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name: 'model-abc-token', key: 'HF_TOKEN' } } });
    expect(JSON.stringify(env)).not.toContain('hf_');
  });

  it('runs as nothing of Koala\'s: no service account, no token, nothing privileged, and of the host only the model cache', () => {
    expect(koalaRightsIn([job()], { hostFolder: '/var/lib/rancher/vllm-model-cache' })).toEqual([]);
  });

  it('is named for the folder it fills, within Kubernetes\' name limit', () => {
    expect(modelJobName('a'.repeat(300))).toMatch(/^model-[0-9a-f]{16}$/);
    expect(modelJobName('one')).not.toBe(modelJobName('two'));
  });
});
