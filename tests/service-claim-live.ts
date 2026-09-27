import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios from 'axios';
import { MongoClient } from 'mongodb';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { PlanProposal } from '../apps/backend/src/lib/plan-proposals.js';

const BASE = process.env.CLAIM_LIVE_URL ?? 'http://localhost:3001/api';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  assert.ok(ownerId);
  const user = await db.getUserById(ownerId);
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret);
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const stamp = Date.now().toString(36);
  const service = `forecast${stamp}`;
  const holder = { id: `claim-live-${stamp}`, ownerId, name: 'Forecast service (live check)', type: 'api-service', serviceName: service, projectIds: [`claim-project-${stamp}`], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.saveTree(holder as never);
  const conversationId = (await http.post('/conversations', {})).data.id as string;

  try {
    const goal = `New api-service tree named "Forecast v2" with serviceName ${service}: a tiny HTTP API returning a fixed forecast string. Exactly one branch with one leaf and one task. No research needed.`;
    const { runId } = (await http.post('/engine/runs', { agent: 'planner', message: goal, conversationId, inputs: { conversationId, goal } })).data as { runId: string };
    console.log(`  run ${runId}`);
    const plan = await (async () => {
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const found = (await db.getPlanProposals(ownerId, conversationId)).find((entry) => entry.status === 'proposed' && entry.plan?.tree);
        if (found) return found as PlanProposal;
        if (Date.now() > deadline) throw new Error('no plan was proposed');
        await sleep(5_000);
      }
    })();
    const tree = plan.plan!.tree!;
    console.log(`  the planner proposed "${tree.name}" with service ${tree.serviceName ?? '(none)'}`);
    assert.equal(tree.serviceName, service, 'the plan did not carry the service name');
    assert.deepEqual(tree.joins, { treeId: holder.id, treeName: holder.name, projectId: holder.projectIds[0] }, 'the claim on the existing service was not recorded');
    console.log(`  the proposal records that it joins "${holder.name}" and its project`);
    console.log('service claim live — PASS');
  } finally {
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    const mongo = new MongoClient(process.env.MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin');
    await mongo.connect();
    await mongo.db('provisioning').collection('trees').deleteOne({ _id: holder.id as never });
    await mongo.db('provisioning').collection('planProposals').deleteMany({ conversationId });
    await mongo.close();
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
