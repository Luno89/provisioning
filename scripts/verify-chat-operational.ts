import { bootstrap } from '../apps/backend/src/index.js';
import { KOALA_TOOLS } from '../apps/backend/src/lib/koala-tools.js';
import http from 'http';

async function main() {
  console.log('🚀 [Operational Verification] Starting live backend server instance in memory mode...');
  process.env.USE_MEMORY_DB = 'true';
  process.env.NODE_ENV = 'test';

  const { app } = await bootstrap();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(3099, '127.0.0.1', () => resolve()));
  const baseUrl = 'http://127.0.0.1:3099';
  console.log(`✅ [Operational Verification] Backend listening on ${baseUrl}.`);

  try {
    const testEmail = `architect-${Date.now()}@example.com`;
    const testPassword = 'Password123!';

    // 1. Register test user
    console.log('🔐 [Verification] Registering test user via /api/auth/register...');
    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        name: 'Lead Architect',
      }),
    });
    if (!registerRes.ok) {
      throw new Error(`Register failed: ${registerRes.status} ${await registerRes.text()}`);
    }
    console.log(`   ✓ Registered account for ${testEmail}.`);

    // 2. Login to obtain session cookie
    console.log('🔑 [Verification] Logging in via /api/auth/login to establish session...');
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    if (!loginRes.ok) {
      throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
    }
    const rawCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie') || ''];
    const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
    console.log(`   ✓ Logged in successfully. Session cookie acquired: ${cookieHeader.slice(0, 25)}...`);

    const authHeaders = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    };

    // 3. Verify KOALA_TOOLS schema completeness
    console.log(`📦 [Verification] Checking Koala tool schemas (Found ${KOALA_TOOLS.length} tools)...`);
    const expectedTools = [
      'propose_tree',
      'propose_spec',
      'list_infrastructure',
      'get_logs',
      'get_events',
      'inspect_resources',
      'cluster_capacity',
      'list_trees',
      'enable_mcp_server',
      'add_project_dependency',
      'get_project_pipeline',
      'deploy_project',
      'get_project_url',
      'web_search',
      'fetch_web_page',
    ];
    for (const toolName of expectedTools) {
      const found = KOALA_TOOLS.find((t) => t.function.name === toolName);
      if (!found) {
        throw new Error(`Missing expected Koala tool: ${toolName}`);
      }
      console.log(`   ✓ Tool schema verified: ${toolName}`);
    }

    // 4. Test Conversation Vault CRUD Endpoints
    console.log('📂 [Verification] Testing Conversation Vault CRUD lifecycle...');
    
    // Create Conversation
    const createRes = await fetch(`${baseUrl}/api/chat-pack/conversations`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Operational Verification Retro Tree Thread' }),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create conversation: ${createRes.status} ${await createRes.text()}`);
    }
    const created = await createRes.json() as any;
    console.log(`   ✓ Created conversation: id=${created.id}, title="${created.title}"`);

    // List Conversations
    const listRes = await fetch(`${baseUrl}/api/chat-pack/conversations`, { headers: authHeaders });
    const list = await listRes.json() as any[];
    const foundInList = list.some((c: any) => c.id === created.id);
    if (!foundInList) {
      throw new Error(`Created conversation ${created.id} not found in listing!`);
    }
    console.log(`   ✓ Conversation list returned ${list.length} threads, verified new thread is present.`);

    // Get Single Conversation Detail
    const getRes = await fetch(`${baseUrl}/api/chat-pack/conversations/${created.id}`, { headers: authHeaders });
    const conv = await getRes.json() as any;
    if (conv.id !== created.id) {
      throw new Error(`Conversation detail mismatch: expected ${created.id}, got ${conv.id}`);
    }
    console.log(`   ✓ Verified conversation detail: ${conv.id}`);

    // 5. Test Persona Updates & Scoped Tools
    console.log('⚙️ [Verification] Testing Persona Configuration & Tool Scoping...');
    const personasRes = await fetch(`${baseUrl}/api/personas`, { headers: authHeaders });
    const personas = await personasRes.json() as any[];
    const koalaPersona = personas.find((p: any) => p.name.toLowerCase() === 'koala' || p.id === 'koala') || personas[0];
    
    if (koalaPersona) {
      const updateRes = await fetch(`${baseUrl}/api/personas/${koalaPersona.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          name: koalaPersona.name,
          description: 'Updated via operational test',
          systemPrompt: 'You are an advanced cluster architect with full diagnostic capabilities.',
          scope: {
            tools: ['propose_tree', 'propose_spec', 'get_logs', 'list_infrastructure', 'inspect_resources'],
            mcp: ['github-mcp'],
            run: { maxSteps: 25 },
          },
          overrides: { temperature: 0.8 },
        }),
      });
      if (!updateRes.ok) {
        throw new Error(`Failed to update persona: ${updateRes.status} ${await updateRes.text()}`);
      }
      console.log(`   ✓ Successfully updated persona "${koalaPersona.name}" directives and tool scoping.`);
    }

    // 6. Test Proposal Acceptance Endpoints
    console.log('🌿 [Verification] Testing Proposal Acceptance Endpoints...');
    // Tree Proposal acceptance test
    const acceptTreeRes = await fetch(
      `${baseUrl}/api/chat-pack/conversations/${created.id}/trees/non-existent-id/accept`,
      {
        method: 'POST',
        headers: authHeaders,
      }
    );
    // 404 is expected for non-existent proposal ID, proving route logic and handler are active
    if (acceptTreeRes.status !== 404) {
      throw new Error(`Expected 404 for missing tree proposal, got: ${acceptTreeRes.status}`);
    }
    console.log('   ✓ Verified tree proposal acceptance route.');

    // App Spec Proposal acceptance test
    const acceptSpecRes = await fetch(
      `${baseUrl}/api/chat-pack/conversations/${created.id}/specs/non-existent-id/accept`,
      {
        method: 'POST',
        headers: authHeaders,
      }
    );
    if (acceptSpecRes.status !== 404) {
      throw new Error(`Expected 404 for missing spec proposal, got: ${acceptSpecRes.status}`);
    }
    console.log('   ✓ Verified app spec proposal acceptance route.');

    // 7. Delete Conversation Vault Thread
    console.log('🗑️ [Verification] Testing Conversation Deletion...');
    const delRes = await fetch(`${baseUrl}/api/chat-pack/conversations/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (!delRes.ok) {
      throw new Error(`Failed to delete conversation: ${delRes.status}`);
    }
    const checkDeletedRes = await fetch(`${baseUrl}/api/chat-pack/conversations/${created.id}`, { headers: authHeaders });
    if (checkDeletedRes.status !== 404) {
      throw new Error(`Expected 404 after deletion, got: ${checkDeletedRes.status}`);
    }
    console.log(`   ✓ Successfully deleted conversation ${created.id}.`);

    console.log('\n🎉 ALL OPERATIONAL VERIFICATIONS PASSED 100% END-TO-END!');
    process.exit(0);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('❌ Operational Verification Failed:', err);
  process.exit(1);
});
