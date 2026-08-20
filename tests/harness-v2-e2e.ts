/**
 * Live End-to-End Operational Verification for Harness V2.
 *
 * Exercises the entire client-facing API flow against the live running Express backend:
 * 1. Mock OAuth login & session cookie acquisition
 * 2. Session verification (/api/auth/me)
 * 3. Platform OpenAPI specification inspection (/api/openapi.json)
 * 4. In-chat dynamic conversational turn to real LLM
 * 5. In-chat coding task proposal generation with dynamic rubrics
 * 6. Proposal acceptance & task creation in Temporal
 * 7. Task details & trace inspection
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

  console.log('\n--- Step 3: Verifying Platform OpenAPI Specification ---');
  const openapiRes = await axios.get(`${API_BASE}/openapi.json`);
  if (openapiRes.status !== 200 || !openapiRes.data.openapi || !openapiRes.data.paths['/clusters']) {
    throw new Error(`Failed /api/openapi.json: status ${openapiRes.status}`);
  }
  console.log(`✓ Platform OpenAPI v${openapiRes.data.openapi} loaded with ${Object.keys(openapiRes.data.paths).length} endpoints`);

  console.log('\n--- Step 4: Creating New Planning Session ---');
  const createRes = await client.post(`${API_BASE}/harness-v2/conversations`, {});
  if (!createRes.data.success || !createRes.data.conversation?.id) {
    throw new Error(`Failed to create conversation: ${JSON.stringify(createRes.data)}`);
  }
  const convId = createRes.data.conversation.id;
  console.log(`✓ Created conversation session: ${convId}`);

  console.log('\n--- Step 5: Testing Live Dynamic Conversation with Real LLM ---');
  const chatRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/messages`, {
    content: 'What is 17 multiplied by 4? Please explain the step-by-step calculation.',
  });
  if (!chatRes.data.success || !chatRes.data.assistantMessage) {
    throw new Error(`Chat message failed: ${JSON.stringify(chatRes.data)}`);
  }
  const reply = chatRes.data.assistantMessage.content;
  console.log('✓ Dynamic LLM Response Received:\n', reply.trim());
  if (!reply.includes('68')) {
    throw new Error(`Expected real arithmetic calculation result (68) in reply, got: ${reply}`);
  }

  console.log('\n--- Step 6: Dispatching Coding Task Request to Real LLM ---');
  const msgRes = await client.post(`${API_BASE}/harness-v2/conversations/${convId}/messages`, {
    content: 'Please formulate a structured task proposal in JSON to implement a token bucket rate limiter for API endpoints with personaId coder.',
  });
  if (!msgRes.data.success || !msgRes.data.assistantMessage) {
    throw new Error(`Failed to post message: ${JSON.stringify(msgRes.data)}`);
  }
  const assistantMsg = msgRes.data.assistantMessage;
  console.log('✓ Proposals Received:', assistantMsg.proposals?.length ?? 0);

  if (!assistantMsg.proposals || assistantMsg.proposals.length === 0) {
    throw new Error('Expected at least 1 task proposal in reply');
  }
  const proposal = assistantMsg.proposals[0];
  console.log(`✓ Proposed Task: "${proposal.title}" (Persona: ${proposal.personaId}, Budget: ${proposal.budget.maxTurns} turns)`);

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
