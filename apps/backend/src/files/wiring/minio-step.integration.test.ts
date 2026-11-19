import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';
import { localCommands, removeSteps, runSteps, StepFailed, type Step } from '@koala/provision';
import { containerProvider, type ContainerContext, memoryReporter } from '@koala/provision/testing';
import { MINIO_TEST_IMAGE, startMinio } from '../testing/real-minio.js';
import { minioStep } from './minio-step.js';

const ctx: ContainerContext = { commands: localCommands(process.env) };
const made: Array<() => Promise<void>> = [];
afterEach(async () => { for (const undo of made.splice(0)) await undo(); });

describe('MinIO, started by its one step', () => {
  it('answers the health check Koala watches MinIO with, and stopping removes its container', async () => {
    const minio = await startMinio();
    made.push(() => minio.stop());
    const { endPoint, port } = minio.settings;
    expect((await fetch(`http://${endPoint}:${port}/minio/health/live`)).ok).toBe(true);
    await minio.stop();
    const left = await ctx.commands.run({ command: 'docker', args: ['ps', '-a', '--filter', `name=^${minio.name}$`, '--format', '{{.Names}}'] }, { line: () => undefined });
    expect(left.stdout.trim()).toBe('');
  });

  it('fails as soon as MinIO exits, saying what it said', async () => {
    const container = containerProvider({ name: `koala-minio-test-${randomUUID().slice(0, 8)}`, image: MINIO_TEST_IMAGE, run: [...throwawayLabel(), '-p', '127.0.0.1::9000'], command: ['server'], publish: [9000] });
    const step: Step<ContainerContext> = minioStep(container, () => ({ endPoint: '127.0.0.1', port: container.published(9000), useSSL: false }));
    made.push(() => removeSteps([step], ctx, memoryReporter()));
    const failure: unknown = await runSteps([step], ctx, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(new RegExp(`^MinIO, the file store, to answer: ${container.name} exited with [1-9]`));
    expect((failure as StepFailed).tail.join('\n')).toMatch(/server/i);
  });
});
