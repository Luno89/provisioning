import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

const BASE = process.env.INFRA_LIVE_URL ?? 'http://localhost:3001/api';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  const owner = ownerId ? await db.getUserById(ownerId) : (await db.getUsers())[0];
  await db.close();
  assert.ok(owner, 'there is no user to provision as');
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');

  const http = axios.create({
    baseURL: BASE,
    proxy: false,
    headers: { Cookie: `session=${signJWT({ userId: owner.id, email: owner.email }, secret, 3600)}` },
  });
  const infra = new InfrastructureService();
  const name = `test-infra-${Date.now().toString(36)}`;
  const kubeconfig = `/tmp/kubeconfig-${name}`;
  let id: string | undefined;

  console.log(`provisioning ${name} through POST /api/clusters`);
  try {
    await http.post('/clusters', { name, provider: 'k3d' });
    id = await until(`${name} to be healthy`, 20 * 60_000, async () => {
      const mine = ((await http.get('/clusters')).data as { id: string; name: string; status: string }[]).find((cluster) => cluster.name === name);
      if (mine?.status === 'failed') throw new Error(`${name} failed to provision`);
      return mine?.status === 'healthy' ? mine.id : undefined;
    });

    const nodes = JSON.parse(String(await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfig))) as { items: { status: { conditions: { type: string; status: string }[] } }[] };
    assert.ok(nodes.items.some((node) => node.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True')), 'no node is Ready');
    const operator = String(await infra.runHelm(['status', 'infisical-operator', '-n', 'infisical'], kubeconfig));
    assert.match(operator, /STATUS: deployed/, 'the secrets operator was not installed');
    console.log(`  ${name} is healthy, a node is Ready, and the secrets operator is deployed`);
  } finally {
    if (id) {
      await http.delete(`/clusters/${id}`);
      await until(`${name} to be deleted`, 10 * 60_000, async () => {
        const left = ((await http.get('/clusters')).data as { name: string }[]).some((cluster) => cluster.name === name);
        return left ? undefined : true;
      });
      console.log(`  ${name} deleted`);
    }
  }
  console.log('infra integration — PASS');
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
