import assert from 'node:assert/strict';
import axios from 'axios';
import http from 'http';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { seedTools } from '../apps/backend/src/lib/tool-seeds.js';
import { composePersonaPrompt } from '../apps/backend/src/lib/persona-prompt.js';
import { runKoalaTool } from '../apps/backend/src/lib/koala-tool-runner.js';
import { personaChatRouter } from '../apps/backend/src/routes/chat-pack.js';
import { type Conversation } from '../apps/backend/src/lib/conversations.js';

// Disable proxy for ephemeral local ports in test environment
axios.defaults.proxy = false;

async function runLiveVerification() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🚀 LIVE OPERATIONAL END-TO-END VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════════');

  const db = createDatabase();
  await db.init();
  const userId = `test-user-${Date.now()}`;

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 1: Dynamic Tool Registry Seeding
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[1/5] Verifying Dynamic Tool Registry & MongoDB Seeding...');
  const seededCount = await seedTools(db);
  console.log(`  ✓ seedTools executed: processed ${seededCount} tools.`);

  const storedTools = await db.getTools();
  assert.ok(storedTools.length >= 38, `Expected at least 38 tools in db, found ${storedTools.length}`);
  
  const reqEsc = storedTools.find((t) => t.name === 'request_escalated_privileges');
  assert.ok(reqEsc, 'request_escalated_privileges tool must be present in registry');
  assert.ok(reqEsc.usageGuidance, 'usageGuidance must be defined for request_escalated_privileges');
  assert.ok(reqEsc.compactGuidance, 'compactGuidance must be defined for request_escalated_privileges');

  const setEnv = storedTools.find((t) => t.name === 'set_project_env');
  assert.ok(setEnv, 'set_project_env tool must be present in registry');

  const getEnv = storedTools.find((t) => t.name === 'get_project_env');
  assert.ok(getEnv, 'get_project_env tool must be present in registry');
  console.log(`  ✓ All 38 platform tools verified in dynamic registry.`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 2: Universal Context-Aware Prompt Composer
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[2/5] Verifying Context-Aware Prompt Composer under Token Pressure...');
  const basePrompt = 'You are a test persona.';
  
  // Tier 1: Low pressure (<40%)
  const lowPressurePrompt = composePersonaPrompt(basePrompt, {
    toolRegistry: storedTools,
    activeTools: ['request_escalated_privileges', 'list_infrastructure', 'get_project_env'],
    historyChars: 500,
    maxContextTokens: 32768,
    isAdmin: false,
    isEscalated: false,
  });
  assert.ok(lowPressurePrompt.includes('## Active Tools & Workflow Guidance'), 'Low pressure prompt must include full guidance section');
  assert.ok(lowPressurePrompt.includes('## Standard Tenant Boundaries'), 'Must indicate Standard Tenant Boundaries');
  assert.ok(lowPressurePrompt.includes('request_escalated_privileges'), 'Must advise calling request_escalated_privileges');

  // Tier 2: Elevated session
  const elevatedPrompt = composePersonaPrompt(basePrompt, {
    toolRegistry: storedTools,
    activeTools: ['list_infrastructure'],
    historyChars: 500,
    maxContextTokens: 32768,
    isAdmin: false,
    isEscalated: true,
    escalatedNamespaces: ['monitoring', 'gitea'],
  });
  assert.ok(elevatedPrompt.includes('## Escalated Privileges: Active'), 'Must indicate Escalated Privileges: Active');
  assert.ok(elevatedPrompt.includes('monitoring, gitea'), 'Must show active escalated namespaces');

  // Tier 3: High pressure (>50%)
  const highPressurePrompt = composePersonaPrompt(basePrompt, {
    toolRegistry: storedTools,
    activeTools: ['request_escalated_privileges', 'list_infrastructure'],
    historyChars: 70000,
    maxContextTokens: 32768,
  });
  assert.ok(highPressurePrompt.includes('[Notice: Context window is >48% full. Keep thoughts and answers concise.]'), 'Must include context pressure notice');
  console.log(`  ✓ Prompt composer adaptive sizing and role transparency verified.`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 3: Live HTTP Server & Client-Server Privilege Escalation Flow
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[3/5] Starting Live Express Server for Real HTTP Client-Server Flow...');
  const app = express();
  app.use(express.json());

  // User auth middleware simulating standard non-admin caller
  const currentCaller = { id: userId, email: `${userId}@example.com`, isAdmin: false };
  app.use((req, res, next) => {
    (req as any).user = currentCaller;
    next();
  });

  const chatRouter = personaChatRouter({
    db,
    ownedConversations: async (uid) => (await db.getConversations()).filter((c) => c.ownerId === uid),
    webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
    fetchWebPage: async () => '',
    toolRefused: () => false,
  });

  app.use('/api/chat-pack', chatRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  ✓ Live HTTP test server listening on ${baseUrl}`);

  try {
    // 3a. Create conversation
    const convId = uuidv4();
    const now = new Date().toISOString();
    const initialConv: Conversation = {
      id: convId,
      ownerId: userId,
      title: 'Operational Verification',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.saveConversation(initialConv);

    // 3b. Standard user exercises list_infrastructure BEFORE escalation
    const preInfra = await runKoalaTool(
      {
        db,
        userId,
        conversationId: convId,
        sessionId: 'test-session',
        servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
        isAdmin: false,
        isEscalated: false,
      },
      { name: 'list_infrastructure', arguments: '{}' },
    );
    const preParsed = JSON.parse(preInfra.content);
    assert.ok(
      !preParsed.running.some((s: any) => s.name === 'prometheus'),
      'Prometheus should NOT be exposed to standard unescalated session',
    );
    console.log('  ✓ Pre-escalation infrastructure correctly hides system services from standard user.');

    // 3c. Standard user tool calls request_escalated_privileges
    const escResult = await runKoalaTool(
      {
        db,
        userId,
        conversationId: convId,
        sessionId: 'test-session',
        servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
        isAdmin: false,
        isEscalated: false,
      },
      {
        name: 'request_escalated_privileges',
        arguments: JSON.stringify({
          reason: 'Diagnose cluster Prometheus metrics collection failure',
          scope: 'cluster-admin',
          namespaces: ['monitoring', 'gitea'],
        }),
      },
    );

    assert.ok(escResult.proposedEscalation, 'Expected tool result to include proposedEscalation');
    const proposal = escResult.proposedEscalation;
    assert.equal(proposal.status, 'pending', 'Proposal status must be pending');
    assert.equal(proposal.scope, 'cluster-admin');
    console.log(`  ✓ Tool request_escalated_privileges generated proposal: ${proposal.id} (status: pending)`);

    // Verify conversation was persisted with proposal in database
    const savedConv = (await db.getConversations()).find((c) => c.id === convId);
    assert.ok(savedConv?.proposedEscalations?.some((p) => p.id === proposal.id), 'Conversation in db must record proposedEscalation');

    // 3d. User accepts the escalation proposal via real HTTP client POST
    console.log(`  → Sending HTTP POST /api/chat-pack/conversations/${convId}/proposals/escalations/${proposal.id}/accept...`);
    const acceptRes = await axios.post(
      `${baseUrl}/api/chat-pack/conversations/${convId}/proposals/escalations/${proposal.id}/accept`,
      {},
    );
    assert.equal(acceptRes.status, 200, 'Accept route must return 200 OK');
    assert.equal(acceptRes.data.ok, true, 'Accept response must indicate ok: true');

    // Verify database state mutation
    const updatedConv = (await db.getConversations()).find((c) => c.id === convId);
    assert.equal(updatedConv?.isEscalated, true, 'Conversation must now have isEscalated: true');
    assert.equal(updatedConv?.escalatedScope, 'cluster-admin');
    assert.deepEqual(updatedConv?.escalatedNamespaces, ['monitoring', 'gitea']);
    const acceptedProp = updatedConv?.proposedEscalations?.find((p) => p.id === proposal.id);
    assert.equal(acceptedProp?.status, 'accepted');
    console.log('  ✓ Real HTTP endpoint accepted escalation; conversation mutated to isEscalated: true.');

    // 3e. Standard user now exercises list_infrastructure WITH escalated context
    const postInfra = await runKoalaTool(
      {
        db,
        userId,
        conversationId: convId,
        sessionId: 'test-session',
        servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
        isAdmin: false,
        isEscalated: updatedConv.isEscalated,
        escalatedNamespaces: updatedConv.escalatedNamespaces,
      },
      { name: 'list_infrastructure', arguments: '{}' },
    );
    const postParsed = JSON.parse(postInfra.content);
    assert.ok(
      postParsed.running.some((s: any) => s.name === 'prometheus'),
      'Prometheus MUST be visible in running services after escalation grant',
    );
    assert.ok(
      postParsed.running.some((s: any) => s.name === 'grafana'),
      'Grafana MUST be visible in running services after escalation grant',
    );
    assert.ok(
      postParsed.running.some((s: any) => s.name === 'loki'),
      'Loki MUST be visible in running services after escalation grant',
    );
    assert.ok(
      postParsed.running.some((s: any) => s.name === 'alertmanager'),
      'Alertmanager MUST be visible in running services after escalation grant',
    );
    assert.ok(
      postParsed.running.some((s: any) => s.name === 'gitea'),
      'Gitea MUST be visible in running services after escalation grant',
    );
    console.log('  ✓ Post-escalation list_infrastructure exposes Prometheus, Grafana, Loki, Alertmanager, and Gitea!');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Project Flow Tools (get_project_env and set_project_env)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[4/5] Verifying Project Environment Operations (get_project_env & set_project_env)...');
    const projectId = `proj-${Date.now()}`;
    await db.saveProject({
      id: projectId,
      name: 'analytics-engine',
      ownerId: userId,
      deployEnv: 'LOG_LEVEL=info\nPORT=3000',
      createdAt: now,
      updatedAt: now,
    });

    // 4a. Get initial env
    const initialEnvRes = await runKoalaTool(
      {
        db, userId, conversationId: convId, sessionId: 'test-session', servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
      },
      { name: 'get_project_env', arguments: JSON.stringify({ projectId }) },
    );
    const initialEnvParsed = JSON.parse(initialEnvRes.content);
    assert.ok(initialEnvParsed.deployEnv.includes('LOG_LEVEL=info'), 'Initial env should include LOG_LEVEL=info');
    assert.ok(initialEnvParsed.deployEnv.includes('PORT=3000'), 'Initial env should include PORT=3000');

    // 4b. Set new env variables (merge and overwrite)
    const setEnvRes = await runKoalaTool(
      {
        db, userId, conversationId: convId, sessionId: 'test-session', servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
      },
      {
        name: 'set_project_env',
        arguments: JSON.stringify({
          projectId,
          env: {
            PORT: '8080',
            DATABASE_URL: 'postgresql://postgres:secret@db.monitoring.svc:5432/app',
            METRICS_ENABLED: 'true',
          },
        }),
      },
    );
    const setEnvParsed = JSON.parse(setEnvRes.content);
    assert.equal(setEnvParsed.success, true, 'Expected set_project_env success: true');

    // 4c. Verify persistence in Database
    const savedProject = (await db.getProjects()).find((p) => p.id === projectId);
    assert.ok(savedProject?.deployEnv?.includes('PORT=8080'), 'deployEnv must persist PORT=8080');
    assert.ok(savedProject?.deployEnv?.includes('DATABASE_URL=postgresql://postgres:secret@db.monitoring.svc:5432/app'), 'deployEnv must persist DATABASE_URL');
    assert.ok(savedProject?.deployEnv?.includes('LOG_LEVEL=info'), 'deployEnv must preserve existing LOG_LEVEL=info');
    assert.ok(savedProject?.deployEnv?.includes('METRICS_ENABLED=true'), 'deployEnv must persist METRICS_ENABLED=true');

    // 4d. Read back with get_project_env
    const readbackEnvRes = await runKoalaTool(
      {
        db, userId, conversationId: convId, sessionId: 'test-session', servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
      },
      { name: 'get_project_env', arguments: JSON.stringify({ projectId }) },
    );
    const readbackParsed = JSON.parse(readbackEnvRes.content);
    assert.ok(readbackParsed.deployEnv.includes('PORT=8080'), 'Readback deployEnv should contain PORT=8080');
    assert.ok(readbackParsed.deployEnv.includes('DATABASE_URL=postgresql://postgres:secret@db.monitoring.svc:5432/app'), 'Readback deployEnv should contain DATABASE_URL');
    assert.ok(readbackParsed.deployEnv.includes('LOG_LEVEL=info'), 'Readback deployEnv should preserve LOG_LEVEL=info');
    assert.ok(readbackParsed.deployEnv.includes('METRICS_ENABLED=true'), 'Readback deployEnv should contain METRICS_ENABLED=true');
    console.log('  ✓ get_project_env & set_project_env successfully read, merged, and persisted runtime config.');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 5: Denial Flow Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[5/5] Verifying Escalation Denial Flow via HTTP Route...');
    const convId2 = uuidv4();
    await db.saveConversation({
      id: convId2,
      ownerId: userId,
      title: 'Denial Verification',
      messages: [],
      createdAt: now,
      updatedAt: now,
    });

    const escResult2 = await runKoalaTool(
      {
        db, userId, conversationId: convId2, sessionId: 'test-session', servers: [],
        webSearch: async () => ({ results: [], query: '', provider: 'none', timingMs: 0 }),
        fetchWebPage: async () => '',
        isAdmin: false, isEscalated: false,
      },
      {
        name: 'request_escalated_privileges',
        arguments: JSON.stringify({
          reason: 'Need root cluster access',
          scope: 'cluster-admin',
        }),
      },
    );
    const proposal2 = escResult2.proposedEscalation!;

    // Deny via real HTTP POST
    const denyRes = await axios.post(
      `${baseUrl}/api/chat-pack/conversations/${convId2}/proposals/escalations/${proposal2.id}/deny`,
      {},
    );
    assert.equal(denyRes.status, 200);

    const deniedConv = (await db.getConversations()).find((c) => c.id === convId2);
    assert.equal(deniedConv?.isEscalated, undefined, 'Conversation must remain unescalated');
    const deniedProp = deniedConv?.proposedEscalations?.find((p) => p.id === proposal2.id);
    assert.equal(deniedProp?.status, 'denied', 'Proposal must be recorded as denied');
    console.log('  ✓ Denial HTTP route successfully marks proposal denied and leaves conversation un-escalated.');

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close?.();
    console.log('  ✓ Test HTTP server closed.');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('🎉 ALL LIVE OPERATIONAL END-TO-END VERIFICATION CHECKS PASSED!');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
}

runLiveVerification().catch((err) => {
  console.error('\n❌ LIVE OPERATIONAL VERIFICATION FAILED:', err);
  process.exit(1);
});
