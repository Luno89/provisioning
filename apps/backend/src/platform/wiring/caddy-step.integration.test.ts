import { afterEach, describe, expect, it } from 'vitest';
import { localCommands, removeSteps, runSteps, StepFailed, type Step } from '@koala/provision';
import { memoryReporter, type ContainerContext } from '@koala/provision/testing';
import { edgeCaddy } from '../testing/edge-caddy.js';

const ctx: ContainerContext = { commands: localCommands(process.env) };
const made: Step<ContainerContext>[] = [];
afterEach(async () => { await removeSteps(made.splice(0), ctx, memoryReporter()); });

function caddyWith(caddyfile: string) {
  const caddy = edgeCaddy(caddyfile);
  made.push(caddy.step);
  return caddy;
}

describe('Caddy, started by the step root\'s Caddy is', () => {
  it('is done once its admin API answers', async () => {
    const caddy = caddyWith('{\n\tadmin 0.0.0.0:2019\n}\n');
    await runSteps([caddy.step], ctx, memoryReporter());
    expect((await fetch(`${caddy.admin()}/config/`)).status).toBe(200);
  });

  it('fails as soon as Caddy exits on a Caddyfile it cannot adapt, saying what it said', async () => {
    const caddy = caddyWith('{\n\tadmin 0.0.0.0:2019\n\tno_such_option\n}\n');
    const failure: unknown = await runSteps([caddy.step], ctx, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(new RegExp(`^Caddy, answering on its admin API to answer: ${caddy.container.name} exited with 1`));
    expect((failure as StepFailed).tail.join('\n')).toContain('no_such_option');
  });
});
