import path from 'node:path';
import type { Progress, Step, StepState } from '@koala/provision';
import { archOf, koalaBin, SILENT, type JoinContext } from '../context.js';

export const helmAt = (ctx: JoinContext): string => path.join(koalaBin(ctx), 'helm');

async function helmState(ctx: JoinContext): Promise<StepState> {
  const helm = helmAt(ctx);
  if (!await ctx.host.ownExecutable(helm)) return { done: false, why: `${helm} is not there` };
  const said = (await ctx.commands.run({ command: helm, args: ['version', '--short'] }, SILENT)).stdout.trim();
  return said.startsWith(`${ctx.pins.helm.version}+`) ? { done: true } : { done: false, why: `${helm} is ${said || 'a helm that does not say its version'}, not ${ctx.pins.helm.version}` };
}

async function installHelm(ctx: JoinContext, progress: Progress): Promise<void> {
  const { helm } = ctx.pins;
  const arch = archOf(ctx);
  const scratch = await ctx.host.scratch();
  try {
    const archive = path.join(scratch.dir, 'helm.tar.gz');
    await ctx.host.download(`helm ${helm.version}`, helm.url(arch), archive, helm.sha256[arch]);
    await ctx.commands.run({ command: 'tar', args: ['-xzf', archive, '-C', scratch.dir] }, progress);
    await ctx.commands.run({ command: 'install', args: ['-D', '-m', '755', path.join(scratch.dir, `linux-${arch}`, 'helm'), helmAt(ctx)] }, progress);
  } finally {
    await scratch.remove();
  }
  progress.line(`helm ${helm.version} installed in ${koalaBin(ctx)}, for putting Koala here`);
}

export const helmStep = (version: string): Step<JoinContext> => ({
  id: 'helm',
  title: `Installing helm ${version}, for putting Koala on this machine`,
  check: helmState,
  apply: installHelm,
});
