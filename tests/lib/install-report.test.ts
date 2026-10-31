import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/instance/install.sh', import.meta.url).pathname;
const dirs: string[] = [];

const CURL = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -d) printf '%s\\n' "$2" >> "$STUB/reports"; shift ;;
  esac
  shift
done
`;

function reportFunction(): string {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === 'report() {');
  const end = lines.findIndex((line, at) => at > start && line === '}');
  expect(start).toBeGreaterThanOrEqual(0);
  return lines.slice(start, end + 1).join('\n');
}

function reported(calls: string[], env: Record<string, string>): unknown[] {
  const stub = mkdtempSync(join(tmpdir(), 'install-report-'));
  dirs.push(stub);
  writeFileSync(join(stub, 'curl'), CURL);
  chmodSync(join(stub, 'curl'), 0o755);
  const ran = spawnSync('sh', ['-c', `${reportFunction()}\n${calls.join('\n')}`], {
    encoding: 'utf8',
    env: { PATH: `${stub}:${process.env.PATH}`, STUB: stub, ROOT_URL: 'https://root.example', INSTANCE_ID: 'i1', INSTANCE_CREDENTIAL: 'c', ...env },
  });
  expect(ran.status).toBe(0);
  return readFileSync(join(stub, 'reports'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('what install.sh tells root as it goes', () => {
  it('sends JSON root can read at every step, saying it holds a connection', () => {
    expect(reported([
      'report joined "On the mesh as 100.64.0.9"',
      'report installing "Installing the instance" "https://luno.people.example"',
      'report ready "Moved here" "https://luno.people.example" moved',
    ], { MESH_IP: '100.64.0.9', INSTANCE_IMAGE_TAG: 'abc123' })).toEqual([
      { status: 'joined', detail: 'On the mesh as 100.64.0.9', meshIp: '100.64.0.9', presence: true },
      { status: 'installing', detail: 'Installing the instance', url: 'https://luno.people.example', meshIp: '100.64.0.9', presence: true },
      { status: 'ready', detail: 'Moved here', url: 'https://luno.people.example', meshIp: '100.64.0.9', moved: true, imageTag: 'abc123', presence: true },
    ]);
  });

  it('leaves out what it does not know yet', () => {
    expect(reported(['report failed "The install command stopped on this machine; run it again to retry"'], {})).toEqual([
      { status: 'failed', detail: 'The install command stopped on this machine; run it again to retry', presence: true },
    ]);
  });
});
