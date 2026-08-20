# Next-Gen Distributed LLM Harness Architecture: Research Foundations & Synthesis

This document provides a comprehensive synthesis of the two foundational research sources that define the architecture of **Harness V2**:

1. **Source 1: Industry LLM Harness Research Synthesis**
   - *Anthropic*: "Building Effective Agents" (Dec 2024), "Harness Design for Long-Running Application Development" (Mar 2026), "Writing Effective Tools for Agents"
   - *Drata*: "From Prompt Engineering to Harness Engineering" (May 2026)
   - *Abhishek Tiwari*: "Agent Guardrails, Action Gates, Harnesses, and Governance" (May 2026)
   - *Langfuse / Arize Phoenix / OpenTelemetry*: "LLM Evaluation Roadmap & Trace Observability"
   - *Distributed Harness Implementations*: Temporal + Google ADK, AWS CLI Agent Orchestrator (CAO), Oracle 3-Level Model

2. **Source 2: Advanced Agent Lifecycle & Context Deep-Dive**
   - Context degradation and "context anxiety" dynamics
   - Phase-driven context resets with structured handoff artifacts
   - Decoupled 4-layer evaluation framework (Generator vs. Skeptical Judge)
   - Dynamic token and turn budgeting with milestone-driven adaptive extensions
   - Pre-execution AST action gates and path confinement

---

## 1. System Topology Overview

```
                                    ┌──────────────────────────────────────────────────────────────────┐
                                    │                     GOVERNANCE & AUDIT TRAIL                     │
                                    │               (RBAC, Secrets, Multi-Tenant Mesh)                 │
                                    └────────────────────────────────┬─────────────────────────────────┘
                                                                     │
                                                                     ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                      DURABLE TEMPORAL WORKFLOW                                                         │
│                                                                                                                                        │
│  ┌────────────────────────┐        ┌─────────────────────────┐        ┌─────────────────────────┐        ┌──────────────────────────┐  │
│  │   PLANNING / HANDOFF   │───────▶│    MODEL TURN INFERENCE │───────▶│    PRE-EXEC ACTION GATE │───────▶│   GATED TOOL EXECUTION   │  │
│  │  (Structured Artifacts)│        │   (Dynamic Token Budget)│        │  (AST Shell/Path Safety)│        │  (Sandbox & MCP Servers) │  │
│  └────────────────────────┘        └─────────────────────────┘        └─────────────────────────┘        └────────────┬─────────────┘  │
│               ▲                                                                                                       │                │
│               │                                                                                                       │                │
│               └──────────────────────────────────────── STEP SNAPSHOT & STATE ◀───────────────────────────────────────┘                │
│                                                                                                                                        │
└────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────┘
                                                                     │
                                                                     ▼
                                    ┌──────────────────────────────────────────────────────────────────┐
                                    │                  INDEPENDENT SKEPTICAL EVALUATOR                 │
                                    │       (Layer 0 Structural + Layer 1 E2E + Layer 2 Rubric Evals)  │
                                    └──────────────────────────────────────────────────────────────────┘
```

---

## 2. Pillar 1: The Shift from "Prompt Engineering" to "Harness Engineering"

### 2.1 The Core Philosophy
A model's raw reasoning capacity is secondary to the reliability of the execution environment wrapping it:
- **Without a Harness**: Unhandled tool errors, malformed JSON, network dropouts, or token buffer saturation trigger compounding hallucinations, loops, or abrupt task termination.
- **With a Harness**: The environment enforces deterministic state transitions, catches failures at the exact atomic sub-step, resets degraded context windows, and gates side effects.

### 2.2 Workflows vs. Autonomous Agents
- **Deterministic Workflows**: Predefined code paths orchestrated with state machines. Ideal for predictable tasks (provisioning clusters, deployments).
- **Autonomous Agents**: LLMs dynamically deciding their own tool execution sequence. Ideal for open-ended exploration, debugging, and software synthesis.
- **The Hybrid Architecture**: Autonomous agent execution loops encapsulated inside durable workflow boundaries (Temporal).

---

## 3. Pillar 2: Execution Durability (Activity-Per-Turn Architecture)

### 3.1 The Monolithic Loop Anti-Pattern (Level 1 / Level 2)
Running an entire 20-turn agent execution inside a single loop in memory:
- If the node restarts or an activity fails on Turn 18 of 20, the entire state is lost. Re-executing from Turn 1 doubles token burn, repeats destructive actions, and introduces non-determinism.

### 3.2 The Atomic Activity-Per-Turn Pattern (Level 3)
Every conversational turn is deconstructed into discrete, durable Temporal activities:
1. **`ModelTurnActivity`**: Submits context to the model and receives structured thoughts or tool calls.
2. **`ActionGateActivity`**: Evaluates proposed tool calls against security policies before dispatch.
3. **`ExecuteToolActivity`**: Runs the tool in the sandbox or over MCP and captures stdout/stderr.
4. **`SnapshotStateActivity`**: Persists turn telemetry, Git commit SHAs, logs, and token usage.

> **Result**: If an execution stalls on Turn 12, it pauses cleanly. When resumed, Temporal replays history and resumes immediately from Turn 12 without re-running Turns 1–11.

---

## 4. Pillar 3: The 4-Layer Safety & Governance Hierarchy

| Safety Layer | Scope | Interception Point | What It Inspects |
|---|---|---|---|
| **1. Guardrails** | Text filtering | Model Boundary (I/O) | Toxic text, prompt injection, regex PII leakage in raw prose. |
| **2. Action Gate** | Pre-execution safety | Before Sandbox / MCP Dispatch | Tool name, shell AST command structure, target file paths, parameter ranges, agent permissions. |
| **3. Harness** | Runtime resilience | Execution Sandbox | Step quotas, timeout interrupts, circuit breakers, process isolation, memory ceilings. |
| **4. Governance** | Policy & compliance | Cross-cutting Platform | Multi-tenant namespace isolation, device ownership mesh checks, tamper-evident audit trails. |

> **Key Rule**: Guardrails only inspect prose. An **Action Gate** is required to answer: *"Should this specific agent be allowed to execute this exact shell command or file write right now?"*

---

## 5. Pillar 4: Context Management & The "Context Anxiety" Solution

### 5.1 The Phenomenon
As token context windows fill up:
1. **Needle-in-a-Haystack Loss**: Architectural requirements stated in early turns are lost or ignored.
2. **Context Anxiety**: Models detect the approaching token ceiling and prematurely terminate tasks ("I have completed the setup" when files are unwritten).
3. **Degenerate Loops**: Models repeat failing shell commands or tool calls in circular loops.

### 5.2 The Solution: Phase-Driven Context Resets
Rather than continuously truncating or lossily summarizing a 50-turn conversation history:
1. **Structured Handoff Artifacts**: The harness forces the generation of version-controlled markdown artifacts (`Plan.md` $\rightarrow$ `Progress.md` $\rightarrow$ `Implement.md` $\rightarrow$ `Review.md`).
2. **Fresh Agent Bootstrapping**: At major phase transitions, the harness **wipes the raw turn history completely** and boots a fresh agent instance whose context contains only:
   - The System Persona definition.
   - The verified Handoff Artifacts.
   - The clean workspace files.

---

## 6. Pillar 5: Decoupled Multi-Agent Evaluation (Generator vs. Skeptical Judge)

### 6.1 The Self-Evaluation Bias
When an agent is asked *"Did you finish the task and is your code correct?"*, it skews overwhelmingly positive. Self-evaluation is inherently uncalibrated and unreliable.

### 6.2 Decoupled Evaluator Architecture
The harness separates the **Generator Agent** (which writes code and builds features) from an **Independent Skeptical Evaluator Agent**:
- **Layer 0 (Structural & Static)**: JSON schema compliance, TypeScript compiler pass (`tsc`), exit codes.
- **Layer 1 (Deterministic E2E & Tests)**: Automated unit tests, integration tests, mock server asserts.
- **Layer 2 (Calibrated LLM-as-a-Judge)**: An independent evaluator model scored against explicitly weighted rubrics (e.g., Code Completeness 40%, Spec Fidelity 30%, Error Handling 30%).
- **Layer 3 (Live Telemetry)**: Verification against running client-server HTTP routes, state mutations, and error logs.

---

## 7. Pillar 6: Dynamic Resource Budgeting & Adaptive Extensions

### 7.1 Moving Past Static Turn Caps
Static caps (e.g., "always max 10 steps") fail because:
- Simple tasks waste time and tokens.
- Complex architectural refactors fail right before completion because they ran out of turns.

### 7.2 Dynamic Budgeting
- **Complexity Estimation**: Initial token and turn quotas are estimated dynamically based on the scope, file count, and description complexity.
- **Milestone-Based Adaptive Extension**: If an agent makes measurable forward progress (e.g., tests transition from failing to passing, files are successfully written) but requires more turns, the harness grants an adaptive extension rather than failing abruptly.

---

## 8. Summary Comparison Matrix

| Dimension | Legacy / Level 1 Systems | Level 2 (In-Loop) | Greenfield Harness V2 (Level 3) |
|---|---|---|---|
| **Execution** | Raw script loop | Single monolithic Temporal activity | **Atomic Activity-per-Turn Temporal Workflow** |
| **Safety** | None / basic regex | Post-execution catch blocks | **Pre-Execution AST Action Gate & Confinement** |
| **Context** | Raw unbounded history | Lossy token trimming | **Phase-Driven Context Resets + Handoff Docs** |
| **Evaluation** | Agent says "Done" | Unit tests only | **Decoupled Skeptical LLM Judge + 4-Layer Evals** |
| **Tool Calling** | Hardcoded scripts | Static schema strings | **Live OpenAPI 3.0 Discovery + MCP Ecosystem** |
| **Budgeting** | Hardcoded step cap | Hardcoded step cap | **Dynamic Complexity Budget + Adaptive Extensions** |
