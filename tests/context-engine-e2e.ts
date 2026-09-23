import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_COMPACTION_CONFIG,
  createCompactionConfig,
  estimateMessageTokens,
  calculatePressure,
  evalCompactionPhase,
  clampDualBoundary,
  maskToolObservation,
  extractContinuityState,
  renderContinuityNotice,
  progressiveCompact,
} from '@koala/context-engine';
import { clampToolResult, handOff } from '@koala/agent-engine/procedure';
import { buildHandoffNotice } from '../apps/backend/src/lib/koala-context.js';
import { DEFAULT_BUDGET } from '../apps/backend/src/lib/pack-seeds.js';
import { trimTranscript } from '../apps/backend/src/lib/leaves.js';
import { runCommand } from '../apps/local-agent/src/sandbox-handlers.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { conversationsRouter } from '../apps/backend/src/routes/conversations.js';
import type { Conversation, ConversationMessage } from '../apps/backend/src/lib/conversations.js';

// Disable proxy for ephemeral local ports in test environment
axios.defaults.proxy = false;

async function runContextEngineOperationalVerification() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🚀 CONTEXT ENGINE LIVE END-TO-END OPERATIONAL VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════════');

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Dual-Boundary Output Clamping Invariant (No Head/Tail loss)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[1/5] Verifying Dual-Boundary Clamping Invariants...');
  {
    const structuredOutput = '{"schema_version": "v1.2", "items": [' + 'x'.repeat(5000) + '], "status": "ok"}';
    const clampedStructured = clampDualBoundary(structuredOutput, {
      maxChars: 400,
      headRatio: 0.8,
    });
    assert.ok(clampedStructured.includes('{"schema_version": "v1.2"'), 'Structured head must be preserved');
    assert.ok(clampedStructured.includes('"status": "ok"}'), 'Structured tail must be preserved');
    assert.ok(clampedStructured.includes('characters omitted'), 'Marker must indicate omitted characters');

    const logOutput = 'Build started: Step 1/10\n' + 'intermediate build log line\n'.repeat(200) + 'FATAL: Compilation failed at line 42\nError code: 1';
    const clampedLog = clampDualBoundary(logOutput, {
      maxChars: 400,
      headRatio: 0.2, // Tail-heavy for logs
    });
    assert.ok(clampedLog.includes('Build started'), 'Log header must be preserved');
    assert.ok(clampedLog.includes('FATAL: Compilation failed at line 42'), 'Log error tail must be preserved');
    console.log('  ✓ Dual-boundary clamping preserves both invocation heads and diagnostic tails.');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Local-Agent Live Command Execution & Clamping
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[2/5] Verifying Local-Agent Live Command Execution & Clamping...');
  {
    const result = await runCommand(
      process.cwd(),
      'node -e "console.log(\'HEAD_LINE\'); for(let i=0;i<500;i++) console.log(\'line-\' + i); console.log(\'TAIL_ERROR_LINE\');"',
      { maxOutputChars: 500, headRatio: 0.2 },
    );
    assert.equal(result.exitCode, 0, 'Command should exit successfully');
    assert.ok(result.stdout.includes('HEAD_LINE'), 'Command head line must be preserved');
    assert.ok(result.stdout.includes('TAIL_ERROR_LINE'), 'Command tail line must be preserved');
    assert.ok(result.stdout.length <= 650, `Output length (${result.stdout.length}) must respect maxOutputChars`);
    console.log(`  ✓ Local-agent executed real child process and clamped output with dual-boundary preserving head and tail.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Agent-Engine Context Node Continuity & Clamping
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[3/5] Verifying Agent-Engine Context Node Continuity & Clamping...');
  {
    const longTool = clampToolResult('START_DATA\n' + 'payload\n'.repeat(100) + 'END_DATA', {
      maxChars: 300,
    });
    assert.ok(longTool.includes('START_DATA') && longTool.includes('END_DATA'), 'clampToolResult preserved boundaries');

    const handoffMessages = [
      { role: 'user', content: 'Deploy the database and expose port 5432' },
      { role: 'assistant', content: 'I will inspect the manifests' },
      { role: 'tool', name: 'read_file', content: 'manifest.yaml contents' },
      { role: 'user', content: 'Make sure SSL is disabled for local testing' },
      { role: 'assistant', content: 'Applying configuration' },
      { role: 'tool', name: 'exec', content: 'Error: Connection refused to port 5432' },
    ];
    const extracted = handOff(handoffMessages);
    const noticeContent = extracted[0]?.content ?? '';
    assert.ok(noticeContent.includes('Deploy the database'), 'Primary goal included');
    assert.ok(noticeContent.includes('Make sure SSL is disabled for local testing'), 'Cumulative user directive preserved');
    assert.ok(noticeContent.includes('Connection refused'), 'Error/negative knowledge preserved');
    console.log('  ✓ Agent-engine handoff extracts 5-part continuity without dropping intermediate user directives.');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Progressive 4-Tier Compaction Pipeline
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[4/5] Verifying 4-Tier Progressive Compactor with Zero Hardcoding...');
  {
    const config = createCompactionConfig({
      softThreshold: 0.6,
      hardThreshold: 0.8,
      criticalThreshold: 0.9,
      liveTailTurns: 2,
    });

    const messages = [
      { role: 'system' as const, content: 'You are an autonomous engineering assistant.' },
      { role: 'user' as const, content: 'Initialize project structure and configure database' },
      {
        role: 'assistant' as const,
        content: 'Creating files and schema',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'database.json' }) } }],
      },
      { role: 'tool' as const, tool_call_id: 'tc_1', content: 'Created database.json\n' + 'schema row data;\n'.repeat(1500) },
      {
        role: 'assistant' as const,
        content: 'Database schema written. Now validating.',
        tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ cmd: 'npm test' }) } }],
      },
      { role: 'tool' as const, tool_call_id: 'tc_2', content: 'FAIL: connection failed on port 5432\nerror code 111' },
      { role: 'user' as const, content: 'Please configure postgres port in docker-compose' },
      {
        role: 'assistant' as const,
        content: 'Updating compose file',
        tool_calls: [{ id: 'tc_3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'docker-compose.yml' }) } }],
      },
      { role: 'tool' as const, tool_call_id: 'tc_3', content: 'services:\n  db:\n    ports: ["5432:5432"]\n' + 'config line\n'.repeat(1000) },
      {
        role: 'assistant' as const,
        content: 'Now testing postgres connection',
        tool_calls: [{ id: 'tc_4', type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ cmd: 'npm test' }) } }],
      },
      { role: 'tool' as const, tool_call_id: 'tc_4', content: 'SUCCESS: connected to port 5432' },
      { role: 'assistant' as const, content: 'All services configured and passing.' },
    ];

    const origTokens = estimateMessageTokens(messages);

    // Moderate pressure: soft masking elides intermediate file write bodies
    const softRes = progressiveCompact(messages, {
      windowTokens: Math.round(origTokens * 1.4),
      marginTokens: 0,
      config,
    });
    assert.equal(softRes.phase, 'soft_mask', `Expected soft_mask, got ${softRes.phase}`);
    assert.ok(softRes.messages.length === messages.length, 'Soft mask keeps turn structure');
    assert.ok(softRes.compactedTokens < softRes.originalTokens, 'Soft mask reduced token count');

    // Extreme pressure on multi-turn transcript: hard compaction collapses intermediate conversation
    const longConversation = [
      ...messages,
      ...Array.from({ length: 15 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Architecture discussion step ${i}: Reviewing load balancing and context token constraints for cluster ${i}.`,
      })),
      { role: 'user' as const, content: 'Final verification of the deploy pipeline' },
      { role: 'assistant' as const, content: 'Deploy pipeline fully operational.' },
    ];

    const hardRes = progressiveCompact(longConversation, {
      windowTokens: 1800,
      marginTokens: 0,
      config: createCompactionConfig({
        softThreshold: 0.5,
        hardThreshold: 0.7,
        criticalThreshold: 0.99,
        liveTailTurns: 2,
      }),
    });
    assert.equal(hardRes.phase, 'hard_compact', `Expected hard_compact, got ${hardRes.phase}`);
    assert.ok(hardRes.compactedTokens < hardRes.originalTokens, 'Hard compaction reduced tokens further');
    
    // Check that continuity notice contains the critical directives and negative knowledge
    const continuityMsg = hardRes.messages.find(m => Boolean(m.notice) || (typeof m.content === 'string' && m.content.includes('## Session Continuity State')));
    assert.ok(continuityMsg, 'Must inject session continuity notice');
    const cText = typeof continuityMsg.content === 'string' ? continuityMsg.content : JSON.stringify(continuityMsg.content);
    assert.ok(cText.includes('Initialize project structure'), 'Original goal preserved');
    assert.ok(cText.includes('configure postgres port'), 'Intermediate user directive preserved');
    assert.ok(cText.includes('FAIL: connection failed'), 'Negative knowledge preserved');
    console.log('  ✓ Progressive compactor successfully executed through soft and hard phases preserving scope.');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Live Express HTTP Client-Server Route Exercise
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[5/5] Exercising Live Express Server with Chat-Pack & Backend Compaction Integration...');
  {
    const db = createDatabase();
    await db.init();
    const userId = `test-user-${Date.now()}`;
    const convId = uuidv4();
    const now = new Date().toISOString();

    const initialConv: Conversation = {
      id: convId,
      ownerId: userId,
      title: 'Context Compaction Test',
      messages: [
        { role: 'user', content: 'Build a secure authentication system' },
        { role: 'assistant', content: 'Creating auth routes' },
        { role: 'user', content: 'Use bcrypt for hashing' },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await db.saveConversation(initialConv);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as any).user = { id: userId, email: `${userId}@example.com`, isAdmin: false };
      next();
    });

    const router = conversationsRouter({
      db,
      ownedConversations: async (uid) => (await db.getConversations()).filter((c) => c.ownerId === uid),
    });
    app.use('/api/conversations', router);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Test fetching conversation over live HTTP
      const getRes = await axios.get(`${baseUrl}/api/conversations`);
      assert.equal(getRes.status, 200, 'GET /conversations must succeed');
      const convs = getRes.data;
      assert.ok(Array.isArray(convs), 'Conversations must be an array');
      const found = convs.find((c: any) => c.id === convId);
      assert.ok(found, 'Created conversation must be retrieved over HTTP');

      // Test backend handoff notice on real conversation
      const handoff = buildHandoffNotice(DEFAULT_BUDGET, initialConv);
      assert.ok(handoff.content.includes('Build a secure authentication system'), 'Handoff contains original request');
      assert.ok(handoff.content.includes('Use bcrypt for hashing'), 'Handoff contains subsequent user directive');

      // Test backend trimTranscript with custom config
      const manyMessages = Array.from({ length: 40 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Message ${i}: ${'detail '.repeat(50)}`,
      }));
      const trimmed = trimTranscript(manyMessages, { maxMessages: 10 });
      assert.equal(trimmed.length, 10, 'Transcript trimmed to configured maxMessages');
      assert.ok(trimmed.some(m => m.content.includes('Message 39')), 'Retains recent tail scope');

      console.log('  ✓ Live HTTP endpoints and backend context integration verified successfully.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('✅ ALL CONTEXT ENGINE END-TO-END OPERATIONAL VERIFICATIONS PASSED');
  console.log('═══════════════════════════════════════════════════════════════════════');
}

runContextEngineOperationalVerification().catch((err) => {
  console.error('Operational verification failed:', err);
  process.exit(1);
});
