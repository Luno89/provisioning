# Customization Rules for Agents

## Complete Implementation & No Placeholders
- **Zero Half-Implementations**: NEVER half-implement any feature, view, route, or subsystem. Every feature must be 100% implemented end-to-end across the entire stack — backend services, persistence, API contracts, frontend UI, real-time events, and operational tests. Never leave half-wired buttons, superficial veneers, stubbed callbacks, or partial capabilities.
- **No Dummy Code**: NEVER write placeholders, stubbed functions, mock fallbacks, or incomplete TODOs. Test doubles belong in tests only. Product mock modes that `CLAUDE.md` documents (mock cloud mode, the OAuth and Twilio fallbacks) are features, not stubs.
- **What half-implemented looked like in this repo**, every item shipped and passed its tests:
  - **A UI control the server never reads.** A "sandbox" execution toggle that nothing branched on.
  - **A fake that passes by construction.** A mock model that calls exactly the tools a case expects, scored by checking those same tools.
  - **Canned tool handlers** returning success instead of the real implementations.
  - **An invented placeholder displayed as real data** and then executed.
  - **In-memory storage** for something the user expects to come back to after a restart.
  - **A request field in a shape its consumer silently ignores.**
- **Strict Verification**: Benchmark tasks MUST require real output file creation and exit-code assertions (no `echo` stubs). Never declare success without passing tests/builds.

## Proactive Questioning & Architectural Alignment
- **Ask Before Assuming**: If you are not 100% confident about requirements, terminology, design trade-offs, or system boundaries, STOP and ask the user directly using `ask_question`. Never guess or assume intent.
- **Consult Existing Plans**: Cross-reference existing plan documents (`~/.claude/plans/`, `CLAUDE.md`) and project history first so questions are informed and focused on unsettled decisions.
- **Surface Architectural Decisions**: Any architectural decision, abstraction boundary, or UX paradigm shift MUST be surfaced to the user for explicit review and sign-off before proceeding with execution.

## End-to-End Operational Verification Before Declaring Done
- **Mandatory Live E2E Exercise**: NEVER declare any feature, fix, or capability "done" based solely on isolated unit tests, typechecks, or build compilation passes.
- **Real Client-Server Flow**: You MUST perform a live, end-to-end operational verification against the running application (e.g. authenticating, exercising the actual HTTP/WebSocket API routes, validating client payload contracts, verifying state mutations) proving the exact user flow succeeds end-to-end before concluding.
- **The Real Path, Not a Mock Mode**: A live check run in a mock or fake mode only proves the mock. When reporting, say which parts were exercised live and which were not.

## Deep Analysis & Proposal Protocol
- **Analyze First**: Inspect codebase and trace dependencies before modifying code.
- **Propose Before Modifying**: Present a clear proposal (design choices, open questions, file diffs) and get user approval before changing complex systems.

## Diagnostics & Worker Reloading
- **Inspect Full Logs**: Read full un-truncated error logs before diagnosing. Never mask symptoms or swallow exceptions.
- **Complete Interfaces**: Inspect full symbol definitions before writing consuming code.
- **Temporal Worker Warning**: Activity/workflow edits require restarting `npm run dev` (workers run plain `tsx` and do NOT hot-reload).
