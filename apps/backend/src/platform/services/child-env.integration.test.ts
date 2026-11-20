import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvWorld, namesIn } from '@koala/engine-core/testing/child-env';
import { mainHeads } from '../../hub/services/HubRepoSync.js';
import { ClusterAccess } from '../../infrastructure/services/ClusterAccess.js';
import { InfrastructureService, terraformPlacesFor } from '../../infrastructure/services/InfrastructureService.js';
import { KEY_NAMES } from '../lib/keys.js';
import { nodeProcesses, nodeStreams } from '@koala/engine-core/node-processes';

const KEYS = Object.values(KEY_NAMES);

describe('what a child process of the backend is handed', () => {
  const { dir, printsNames } = childEnvWorld('koala-child-env-', KEYS);

  it('gives helm no platform key', async () => {
    const helm = printsNames('helm', 'out', 0);
    const access = new ClusterAccess({ here: { root: false }, folder: dir, processes: nodeProcesses, streams: nodeStreams, tools: { kubectl: helm, helm } });
    const names = namesIn(await access.helm({ clusterId: 'desk', kind: 'machine', kubeconfig: 'apiVersion: v1\n' }, ['version']));
    expect(names).toContain('PATH');
    for (const key of KEYS) expect(names).not.toContain(key);
  });

  it('gives terraform no platform key', async () => {
    const terraform = printsNames('terraform', 'out', 0);
    const infra = new InfrastructureService(terraformPlacesFor({ kind: 'local' }, mkdtempSync(join(dir, 'data-'))));
    const names = namesIn((await infra.runCommand(terraform, ['plan'], 'child-env', { env: { CD_DIR: dir } })).stdout);
    expect(names).toContain('PATH');
    for (const key of KEYS) expect(names).not.toContain(key);
  });

  it('gives git no platform key', async () => {
    printsNames('git', 'err', 1);
    const said = await mainHeads({ url: 'http://127.0.0.1:9/owner.git' }, { url: 'http://127.0.0.1:9/hub.git' }).then(() => 'answered', (err: Error) => err.message);
    const names = namesIn(said);
    expect(names).toContain('GIT_TERMINAL_PROMPT');
    for (const key of KEYS) expect(names).not.toContain(key);
  });
});
