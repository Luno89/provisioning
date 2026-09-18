#!/usr/bin/env npx tsx
/* eslint-disable no-console */
import axios from 'axios';

const BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

async function main() {
  console.log('===============================================================');
  console.log('  LIVE E2E VERIFICATION: EVALS STUDIO & LEVEL 2 PIPELINE       ');
  console.log('===============================================================\n');

  const http = axios.create({
    baseURL: BASE_URL,
    withCredentials: true,
    validateStatus: () => true,
  });

  const testEmail = `eval-e2e-${Date.now()}@example.com`;
  const testPassword = 'Password123!';

  // 1. Authenticate / Register
  console.log(`[1/7] Authenticating against live backend at ${BASE_URL}...`);
  const { createDatabase } = await import('../lib/db-interface.js');
  const db = createDatabase();
  await db.init();

  const inviteCode = `invite-${Date.now()}`;
  await db.saveInvite({
    id: inviteCode,
    code: inviteCode,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
  });

  const regRes = await http.post('/api/auth/register', {
    email: testEmail,
    password: testPassword,
    inviteCode,
  });

  let cookie = regRes.headers['set-cookie']?.[0];
  if (!cookie) {
    const loginRes = await http.post('/api/auth/login', { email: testEmail, password: testPassword });
    cookie = loginRes.headers['set-cookie']?.[0];
  }

  if (!cookie) {
    throw new Error(`Failed to authenticate. Status: ${regRes.status}, Body: ${JSON.stringify(regRes.data)}`);
  }

  const authHeaders = { Cookie: cookie.split(';')[0] };
  console.log(`  ✓ Authenticated as ${testEmail}\n`);

  // 2. Fetch Level 2 Cases
  console.log('[2/7] Fetching Level 2 Cases from /api/engine/level2/cases...');
  const casesRes = await http.get('/api/engine/level2/cases', { headers: authHeaders });
  if (casesRes.status !== 200 || !Array.isArray(casesRes.data?.cases)) {
    throw new Error(`Expected 200 with cases array, got: ${casesRes.status} ${JSON.stringify(casesRes.data)}`);
  }
  console.log(`  ✓ Received ${casesRes.data.cases.length} active evaluation cases\n`);

  // 3. Create & Persist Custom Scenario to MongoDB
  const scenarioId = `custom/e2e-scenario-${Date.now()}`;
  console.log(`[3/7] Persisting custom scenario "${scenarioId}" to MongoDB...`);
  const customScenario = {
    id: scenarioId,
    name: 'Live Verified E2E Scenario',
    description: 'Verifies dynamic custom procedure execution in mock mode',
    category: 'custom',
    agent: 'research',
    procedure: JSON.stringify({
      id: scenarioId,
      version: '1',
      initialStep: 'plan',
      nodes: [
        { id: 'plan', kind: 'model', tools: 'granted', think: true, next: [{ to: 'execute' }] },
        { id: 'execute', kind: 'dispatch', next: [{ to: 'finish' }] },
        { id: 'finish', kind: 'terminal', outcome: 'ok', reason: 'Custom E2E Success' },
      ],
    }),
    input: {
      message: 'Synthesize verified cluster topology',
      inputs: { cluster: 'k3d-demo' },
    },
    expectedTerminal: 'ok',
    expectedTools: [],
    maxTurns: 5,
  };

  const saveRes = await http.post('/api/engine/level2/scenarios', customScenario, { headers: authHeaders });
  if (saveRes.status !== 201 || !saveRes.data?.ok) {
    throw new Error(`Failed to save scenario: ${saveRes.status} ${JSON.stringify(saveRes.data)}`);
  }
  console.log(`  ✓ Custom scenario persisted successfully in MongoDB\n`);

  // 4. Verify Custom Scenario appears in /api/engine/level2/scenarios
  console.log('[4/7] Verifying scenario list includes custom scenario...');
  const listRes = await http.get('/api/engine/level2/scenarios', { headers: authHeaders });
  const found = (listRes.data?.scenarios ?? []).find((s: any) => s.id === scenarioId);
  if (!found) {
    throw new Error(`Created scenario ${scenarioId} not found in scenario list!`);
  }
  console.log(`  ✓ Custom scenario verified in database listing: "${found.name}"\n`);

  // 5. Start Level 2 Run with Custom Case & Custom Procedure in Mock Mode
  console.log('[5/7] Starting Level 2 Run with customCase, customProcedure, and executionMode: mock...');
  const runPayload = {
    only: [scenarioId],
    customCase: customScenario,
    customProcedure: JSON.parse(customScenario.procedure),
    executionMode: 'mock',
    sampling: { temperature: 0.2 },
    maxTokens: 512,
  };

  const startRes = await http.post('/api/engine/level2/runs', runPayload, { headers: authHeaders });
  if (startRes.status !== 202 || !startRes.data?.id) {
    throw new Error(`Failed to start run: ${startRes.status} ${JSON.stringify(startRes.data)}`);
  }
  const runId = startRes.data.id;
  console.log(`  ✓ Started run id: ${runId} (state=${startRes.data.state})\n`);

  // 6. Poll Run Status until Completion
  console.log(`[6/7] Polling run ${runId} for completion...`);
  let completedRun: any = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const runRes = await http.get(`/api/engine/level2/runs/${runId}`, { headers: authHeaders });
    if (runRes.status !== 200) {
      throw new Error(`Failed to get run status: ${runRes.status}`);
    }
    const run = runRes.data;
    if (run.state !== 'running') {
      completedRun = run;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (!completedRun) {
    throw new Error(`Run ${runId} timed out before completing.`);
  }

  console.log(`  ✓ Run completed with state: "${completedRun.state}"`);
  console.log(`  ✓ Passed: ${completedRun.passedCount}/${completedRun.total}`);
  const firstCaseResult = completedRun.cases?.[0];
  console.log(`  ✓ Terminal Outcome: ${firstCaseResult?.terminalOutcome} (node=${firstCaseResult?.terminalNode})`);
  console.log(`  ✓ Turns executed: ${firstCaseResult?.turns?.length ?? 0}\n`);

  if (completedRun.passedCount !== 1) {
    throw new Error(`Expected run to pass, but passedCount=${completedRun.passedCount}, error=${firstCaseResult?.error}`);
  }

  // 7. Cleanup Custom Scenario
  console.log(`[7/7] Cleaning up custom scenario "${scenarioId}" from MongoDB...`);
  const delRes = await http.delete(`/api/engine/level2/scenarios/${encodeURIComponent(scenarioId)}`, { headers: authHeaders });
  if (delRes.status !== 200 || !delRes.data?.ok) {
    throw new Error(`Failed to delete scenario: ${delRes.status} ${JSON.stringify(delRes.data)}`);
  }
  console.log('  ✓ Custom scenario deleted cleanly from MongoDB\n');

  console.log('===============================================================');
  console.log('  ALL LIVE OPERATIONAL VERIFICATION STEPS PASSED SUCCESSFULLY! ');
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('\n❌ LIVE OPERATIONAL VERIFICATION FAILED:', err);
  process.exit(1);
});
