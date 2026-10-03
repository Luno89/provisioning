import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAsEnv } from './instances.js';

describe('what the installer sources', () => {
  it('reads back every value exactly in a POSIX shell, whatever characters it holds', () => {
    const bundle = {
      instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: "-----BEGIN PUBLIC KEY-----\nab'c$(rm -rf /)\n-----END PUBLIC KEY-----",
      meshLoginServer: 'https://mesh.example.com', preAuthKey: "key'with`quotes`", registry: '100.64.0.1:5001', image: '100.64.0.1:5001/nowrinkles/app',
      imageTag: 'abc', chartUrl: 'https://app.example.com/api/instances/chart.tgz', credential: 'c$HOME',
    };
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'join.env'), bundleAsEnv(bundle));

    const out = execFileSync('sh', ['-c', '. ./join.env; printf "%s\\n%s\\n%s" "$MESH_PREAUTH_KEY" "$INSTANCE_CREDENTIAL" "$(printf "%s" "$ROOT_PUBLIC_KEYS_B64" | base64 -d)"'], { cwd: dir, encoding: 'utf8' });

    expect(out.split('\n').slice(0, 2)).toEqual([bundle.preAuthKey, bundle.credential]);
    expect(out.split('\n').slice(2).join('\n')).toBe(bundle.rootPublicKeys);
  });
});
