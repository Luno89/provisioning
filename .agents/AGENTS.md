# Customization Rules for Agents

## Complete Implementation & No Placeholders
- **No Dummy Code**: NEVER write placeholders, stubbed functions, mock fallbacks, or incomplete TODOs. Every feature must be 100% implemented end-to-end.
- **Strict Verification**: Benchmark tasks MUST require real output file creation and exit-code assertions (no `echo` stubs). Never declare success without passing tests/builds.

## End-to-End Operational Verification Before Declaring Done
- **Mandatory Live E2E Exercise**: NEVER declare any feature, fix, or capability "done" based solely on isolated unit tests, typechecks, or build compilation passes.
- **Real Client-Server Flow**: You MUST perform a live, end-to-end operational verification against the running application (e.g. authenticating, exercising the actual HTTP/WebSocket API routes, validating client payload contracts, verifying state mutations) proving the exact user flow succeeds end-to-end before concluding.

## Deep Analysis & Proposal Protocol
- **Analyze First**: Inspect codebase and trace dependencies before modifying code.
- **Propose Before Modifying**: Present a clear proposal (design choices, open questions, file diffs) and get user approval before changing complex systems.

## Diagnostics & Worker Reloading
- **Inspect Full Logs**: Read full un-truncated error logs before diagnosing. Never mask symptoms or swallow exceptions.
- **Complete Interfaces**: Inspect full symbol definitions before writing consuming code.
- **Temporal Worker Warning**: Activity/workflow edits require restarting `npm run dev` (workers run plain `tsx` and do NOT hot-reload).
