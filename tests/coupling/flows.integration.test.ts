import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Snapshot } from './flows.js';

const ROOT = join(import.meta.dirname, '..', '..');
const out = mkdtempSync(join(tmpdir(), 'flows-'));
const again = mkdtempSync(join(tmpdir(), 'flows-again-'));

const flows = (args: string[]) => spawnSync('npx', ['tsx', join(ROOT, 'tests/coupling/flows-cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(again, { recursive: true, force: true });
});

describe('the flow maps of this repository', () => {
  let snapshot: Snapshot;

  it('are drawn for every v1 flow, from entries that exist', () => {
    const run = flows(['--out', out]);
    expect(run.stderr).not.toMatch(/Error/);
    expect(run.status).toBe(0);
    snapshot = JSON.parse(readFileSync(join(out, 'snapshot.json'), 'utf8')) as Snapshot;
    const specs = JSON.parse(readFileSync(join(ROOT, 'tests/coupling/flows.json'), 'utf8')) as Array<{ name: string }>;
    expect(Object.keys(snapshot.flows).sort()).toEqual(specs.map((spec) => spec.name).sort());
    for (const [name, flow] of Object.entries(snapshot.flows)) {
      expect({ name, missing: flow.missing }).toEqual({ name, missing: [] });
      expect({ name, files: flow.files.files.length > 1 }).toEqual({ name, files: true });
    }
    expect(readFileSync(join(out, 'flows.html'), 'utf8').match(/<pre class="mermaid">/g)).toHaveLength(specs.length);
  }, 0);

  it('follow a deploy from the browser through the workflow it starts to where it reaches a cluster', () => {
    const deploy = snapshot.flows['deploy-model']!;
    expect(deploy.files.links.some((link) => link.through.includes('temporal'))).toBe(true);
    expect(deploy.touches.some((touch) => touch.startsWith('kubeconfig '))).toBe(true);
    expect(deploy.touches.some((touch) => touch.startsWith('cluster-command '))).toBe(true);
  });

  it('follow putting Koala on a machine across the socket to the machine agent', () => {
    expect(snapshot.flows['put-koala-here']!.files.files.some((node) => node.file.startsWith('apps/local-agent/'))).toBe(true);
  });

  it('index every implementation of each concept', () => {
    expect(snapshot.concepts.kubeconfig!.length).toBeGreaterThan(0);
    expect(snapshot.concepts['cluster-command']!.length).toBeGreaterThan(0);
  });

  it('name no change when nothing changed since the snapshot they are compared with', () => {
    const run = flows(['--out', again, '--against', join(out, 'snapshot.json')]);
    expect(run.status).toBe(0);
    expect(readFileSync(join(again, 'changes.txt'), 'utf8').trim()).toBe('No flow or concept changed.');
  }, 0);
});
