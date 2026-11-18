import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { StepFailed } from '@koala/provision';
import { testNamespaces } from '../infrastructure/testing/test-namespaces.js';
import { tinyChart } from '../infrastructure/testing/tiny-chart.js';
import { installKoalaChart } from './install-koala.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
afterAll(async () => { await namespaces.removeAll(); }, 0);

function kubeconfig(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'koala-install-entry-')), 'admin.yaml');
  writeFileSync(file, k3s.admin, { mode: 0o600 });
  return file;
}

const said = () => {
  let text = '';
  return { terminal: { write: (chunk: string) => { text += chunk; } }, text: () => text };
};

describe('the entry dev and the pool put Koala\'s chart on a cluster with, on a real k3s', () => {
  it('applies a chart folder with the values after --, follows it until all is up, and finds it already so when run again', async () => {
    const namespace = namespaces.name('install-entry');
    const argv = ['--kubeconfig', kubeconfig(), '--release', 'tiny', '--namespace', namespace, '--chart', tinyChart(), '--', '--set-string', 'setup=echo seeded'];
    const first = said();
    await installKoalaChart(argv, first.terminal);
    expect(first.text()).toContain('Putting Koala on its cluster');
    const again = said();
    await installKoalaChart(argv, again.terminal);
    expect(again.text()).toMatch(/already/i);
  }, 300_000);

  it('stops naming the setup Job that failed and why', async () => {
    const namespace = namespaces.name('install-entry-fails');
    const out = said();
    const failed = await installKoalaChart(['--kubeconfig', kubeconfig(), '--release', 'tiny', '--namespace', namespace, '--chart', tinyChart(), '--', '--set-string', 'setup=echo no Mongo; exit 2'], out.terminal).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(StepFailed);
    expect((failed as StepFailed).why).toContain('job/tiny-setup-1 failed');
    expect(out.text()).toContain('no Mongo');
  }, 300_000);
});
