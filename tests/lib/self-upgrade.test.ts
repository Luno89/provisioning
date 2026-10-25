import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/instance/self-upgrade.sh', import.meta.url).pathname;
const CHART = 'the chart root released';
const DIGEST = `sha256:${'e'.repeat(64)}`;
const dirs: string[] = [];

const CURL = `#!/usr/bin/env bash
out=""; body=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --data-binary) body=1 ;;
    */api/instances/release) cat "$STUB/release.json"; exit 0 ;;
  esac
  shift
done
[ "$body" -eq 1 ] && { cat >> "$STUB/reports"; echo >> "$STUB/reports"; exit 0; }
[ -n "$out" ] && { cat "$STUB/served-chart" > "$out"; exit 0; }
exit 22
`;
const HELM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB/helm.log"
`;

function upgrade(release: Record<string, string>, served = CHART) {
  const stub = mkdtempSync(join(tmpdir(), 'self-upgrade-'));
  dirs.push(stub);
  writeFileSync(join(stub, 'curl'), CURL);
  writeFileSync(join(stub, 'helm'), HELM);
  chmodSync(join(stub, 'curl'), 0o755);
  chmodSync(join(stub, 'helm'), 0o755);
  writeFileSync(join(stub, 'release.json'), JSON.stringify(release));
  writeFileSync(join(stub, 'served-chart'), served);
  const ran = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, STUB: stub, ROOT_URL: 'https://root.example', INSTANCE_ID: 'i1', INSTANCE_CREDENTIAL: 'c', CURRENT_IMAGE_TAG: 'old111', RELEASE_NAME: 'luno', RELEASE_NAMESPACE: 'nowrinkles' },
  });
  const calls = existsSync(join(stub, 'helm.log')) ? readFileSync(join(stub, 'helm.log'), 'utf8').split('\n').filter(Boolean) : [];
  const reports = existsSync(join(stub, 'reports')) ? readFileSync(join(stub, 'reports'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { status: string; detail: string }) : [];
  return { code: ran.status, calls, reports };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('an instance upgrading itself to what root released', () => {
  const sha = createHash('sha256').update(CHART).digest('hex');

  it('installs the chart root released, pulling the image by its digest', () => {
    const ran = upgrade({ imageTag: 'abc123', chartUrl: 'https://root.example/api/instances/chart.tgz', digest: DIGEST, chartSha256: sha });
    expect(ran.code).toBe(0);
    expect(ran.calls).toHaveLength(1);
    expect(ran.calls[0]).toContain('--set image.tag=abc123 --set-string image.digest=' + DIGEST);
    expect(ran.reports.at(-1)).toEqual({ status: 'ready', detail: 'Upgraded to abc123', imageTag: 'abc123' });
  });

  it('changes nothing when the chart it was sent is not the one root released', () => {
    const ran = upgrade({ imageTag: 'abc123', chartUrl: 'https://root.example/api/instances/chart.tgz', digest: DIGEST, chartSha256: sha }, 'a chart someone swapped in');
    expect(ran.code).toBe(1);
    expect(ran.calls).toEqual([]);
    expect(ran.reports.at(-1)).toEqual({ status: 'failed', detail: 'The chart root sent for abc123 is not the one it released (its sha256 differs), so nothing was changed' });
  });

  it('changes nothing when root names something that is not a digest', () => {
    const ran = upgrade({ imageTag: 'abc123', chartUrl: 'https://root.example/api/instances/chart.tgz', digest: 'latest', chartSha256: sha });
    expect(ran.code).toBe(1);
    expect(ran.calls).toEqual([]);
    expect(ran.reports.at(-1)?.status).toBe('failed');
  });

  it('moves to a release from before digests by its tag, clearing a digest the last one pinned', () => {
    const ran = upgrade({ imageTag: 'mid222', chartUrl: 'https://root.example/api/instances/chart/mid222.tgz' });
    expect(ran.code).toBe(0);
    expect(ran.calls[0]).toContain('--set image.tag=mid222 --set-string image.digest= ');
  });
});
