/**
 * Live End-to-End Operational Verification for Harness V2.
 *
 * Exercises the entire client-facing API flow against the live running Express backend:
 * 1. Mock OAuth login & session cookie acquisition
 * 2. Session verification (/api/auth/me)
 * 3. Conversation creation (/api/harness-v2/conversations)
 * 4. Message dispatch & Orchestrator reasoning + proposal generation
 * 5. Web search tool execution through chat
 * 6. Infrastructure telemetry tool execution through chat
 * 7. Proposal acceptance & task creation
 * 8. Task details & trace inspection
 */
import axios from 'axios';

const BACKEND_URL = 'http://localhost:3001';
const API_BASE = `${BACKEND_URL}/api`;

async function runE2E() {
  console.log('--- Step 1: Acquiring OAuth Session Cookie ---');
  const authRes = await axios.get(`${API_BASE}/auth/google/callback?code=mock-google-code&state=`, {
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const rawCookies = authRes.headers['set-cookie'];
  if (!rawCookies || rawCookies.length === 0) {
    throw new Error('No Set-Cookie header returned from OAuth callback');
  }

  const sessionCookie = rawCookies.map((c) => c.split(';')[0]).join('; ');
  console.log('✓ Session Cookie acquired:', sessionCookie.slice(0, 40) + '...');

  const client = axios.create({
    headers: {
      Cookie: sessionCookie,
    },
    withCredentials: true,
  });

  console.log('\n--- Step 2: Verifying Authenticated Session ---');
  const meRes = await client.get(`${API_BASE}/auth/me`);
  if (meRes.status !== 200 || !meRes.data.email) {
    throw new Error(`Failed /api/auth/me: status ${meRes.status}`);
  }
  console.log(`✓ Authenticated as: ${meRes.data.email} (${meRes.data.id})`);

  console.log('\n--- Step 3: Creating New Planning Session ---');
  const createRes = await client.post(`${API_BASE}/harness-v2/conversations`, {});
  if (!createRes.data.success || !createRes.data.conversation?.id) {
    throw new Error(`Failed to create conversation: ${JSON.stringify(createRes.data)}`);
  }
  const convId = createRes.data.conversation.id;
  console.log(`✓ Created conversation session: ${convId}`);

  console.log('\n--- Step 4: Dispatching Coding Task Request ---');
  const msgRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/messages`, {
    content: 'Implement token bucket rate limiter for API endpoints',
  });
  if (!msgRes.data.success || !msgRes.data.assistantMessage) {
    throw new Error(`Failed to post message: ${JSON.stringify(msgRes.data)}`);
  }
  const assistantMsg = msgRes.data.assistantMessage;
  console.log('✓ Assistant Reasoned:', assistantMsg.reasoning);
  console.log('✓ Proposals Received:', assistantMsg.proposals?.length ?? 0);

  if (!assistantMsg.proposals || assistantMsg.proposals.length === 0) {
    throw new Error('Expected at least 1 task proposal in reply');
  }
  const proposal = assistantMsg.proposals[0];
  console.log(`✓ Proposed Task: "${proposal.title}" (Persona: ${proposal.personaId}, Budget: ${proposal.budget.maxTurns} turns)`);

  console.log('\n--- Step 5: Testing In-Chat Web Search Tool ---');
  const searchMsgRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/messages`, {
    content: 'search web for Temporal TypeScript workflow signals',
  });
  if (!searchMsgRes.data.success) {
    throw new Error(`Web search failed: ${JSON.stringify(searchMsgRes.data)}`);
  }
  console.log('✓ Search Response received with content length:', searchMsgRes.data.assistantMessage.content.length);

  console.log('\n--- Step 6: Testing In-Chat Infrastructure Inspection Tool ---');
  const infraMsgRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/messages`, {
    content: 'what is deployed in the cluster infrastructure?',
  });
  if (!infraMsgRes.data.success) {
    throw new Error(`Infra query failed: ${JSON.stringify(infraMsgRes.data)}`);
  }
  console.log('✓ Infra telemetry received with content length:', infraMsgRes.data.assistantMessage.content.length);

  console.log('\n--- Step 7: Accepting Task Proposal & Launching Temporal Workflow ---');
  const acceptRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/proposals/${proposal.id}/accept`);
  if (!acceptRes.data.success || !acceptRes.data.task?.id) {
    throw new Error(`Failed to accept proposal: ${JSON.stringify(acceptRes.data)}`);
  }
  const launchedTask = acceptRes.data.task;
  console.log(`✓ Successfully launched HarnessTask: ${launchedTask.id} (Status: ${launchedTask.status})`);

  console.log('\n--- Step 8: Inspecting Task Details & Traces ---');
  const taskRes = await client.get(`${API_BASE}/harness-v2/tasks/${launchedTask.id}`);
  const traceRes = await client.get(`${API_BASE}/harness-v2/tasks/${launchedTask.id}/traces`);

  console.log(`✓ Task Status: ${taskRes.data.task.status}`);
  console.log(`✓ Traces Available: ${traceRes.data.traces.length}`);

  console.log('\n========================================');
  console.log('✅ ALL HARNESS V2 LIVE E2E CHECKS PASSED');
  console.log('========================================\n');
}

runE2E().catch((err) => {
  console.error('\n❌ E2E VERIFICATION FAILED:', err.message);
  if (err.response?.data) {
    console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
