# Architectural context

```typescript
def __init__(self, name, instruction, ..., api, agent_llm, provider, tools) ...
```

This monorepo provisions infrastructure and deploys a modern web/UI across multiple platforms.
The architecture is:

| Layer | Purpose | Key implementation |
| --- | --- | --- |
| **Frontend** | Vue 3 + Vite | UI for cluster management, monitoring, deployments |
| **Backend** | Express API | API routes, socket.io connections, workflow orchestrations |
| **Agents** | Session-layer LLM agents | [agents/session-<agent>.ts](agents/session-<agent>.ts) files, each implementing a class with name/instruction description |
| **Infra** | Terraform / CDK | `packages/cdktf-infra` - Terraform-based deployment infrastructure, uses versioned resources |
| **Runtime** | Node/TS runtime | CI/CD, execution environments (k3d, openstack) |

**Key conventions**:

- **Session module**: [def __init__(self, name, instruction, ..., api, agent_llm, provider, tools) ...] is the base class. Each AI Agent (e.g., Architect) has its own `session-module` file with an LLM description embedded.
- **SessionLayer**: OpenAI of session-layer runtime (not direct OpenAI) via `Self + SessionLayer.open()` or `NetworkClient`. The frontend connects to `/session/config` to fetch `defaultInstruction` + prompt, then feeds it to an LLM backend.
- **Artifact pipeline**: AI agent builds artifacts incrementally. Run `cdktf synth` to generate a plan file (Terraform) which is applied via a Helm chart (not Alpha).
- **Transit-based auth**: The system uses simple token-based auth. Not RPC-based.

**Pitfalls to avoid**:

- **`.createContext()` + `Object.readSync` + `.prompt_code()` pattern** in the `SessionLayer` code: these return anomalies (not real responses) that cause `parseState()` timeouts. The session hook test showed compile errors (mismatched types, syntax errors) when running compilation. **Don't rely on these for production.**
- **`pkg/cdktf-infra/lib/session-module.ts`**: careful with how `SessionLayer.open()` is called. It calls `Object.readSync` from stdin with non-interactive mode, which breaks in the test harness.
- **`pkg/cdktf-infra/lib/session-module.ts`**: `pipeline()` is not async-safe. It returns the *terminal* state, but the session state needs to be fetched by `parseState()`. Compile-time check: the system is stateless (no persistent state until SessionLayer fetch).

**How to build the session layer**:
1. There's a `/session/config` endpoint:
```typescript
export const getVmPath = (session: string) => path.resolve(__dirname, session)
export const getPromptData = (sessionState: SessionState) => { 
  return { defaultInstruction: prompt, systemMessages: systemMessages } 
}
export const postPrompt = async (body, sessionState) => { ... LLM call without answer }
```
2. The session module wraps the frontend with a function:
```typescript
export async function __call__(agent: AI, system_prompt: string) { ... }
```
3. Use `defaultInstruction` + actual LLM call (no mock). For end-to-end:
   ```typescript
   await SessionLayer.open(Self).runAI({ prompt, reply, contextCombined })
   await SessionLayer.assume(Self).runChain({ context })
   ```

**Session state/test notes**:
- **`cdktf synth`**: Generates plan file (Terraform) for Helm/helm-based deployed infrastructure. Execute via `terraform plan` + `helm install`. The plan is not the final artifact; it's the *blue print* that's then applied.
- **`cdktf synth`**: Timeout error if Terraform CLI is missing (needs `curl -fsSL https://releases.hashicorp.com/terraform/` etc.)
- **`cdk-synths`**: When `cdktf synth` generates plan errors (e.g., `Module is not defined`), it outputs a valid JSON plan that the agent uses to build the next step.
- **`cdktf synth`**: Output of `cdktf synth` is a JSON plan. `build()` compiles it via `renderJsonToPlan()`.
- **`pnpm run build`**: **Does NOT compile AI context**. It only emits the template file `../session-screen.ts` with a `Pipeline.agentId` reference. The **actual prompt generation happens at runtime** (via `SessionLayer`).

**Be aware**:

- Travis-like tests (`session/.../{test,unit}.ts`) use mocks for AI context but expect the session-module to build artifacts correctly.
- `pnpm run build` + `pnpm test` → **FAILS**. Test output: `codegen[]: null`. The test process fails because `cdktf synth` has been invoked with non-interactive mode, and the AI context is being read via `Object.readSync` from stdin.
- Use `cdktf synth` in a real env or with proper CI settings. Skip AI context checks if running in non-interactive mode (or test with `MockSessionLayer` or similar).
