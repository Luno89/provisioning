---
name: change-list
description: Use before laying out any slice, step, fix or removal for the owner, and before writing code for one. Builds the change list from the coding tools (flow maps, refs, LSP), never from grep, tracing each affected flow from the frontend action to how it ends. Also use when asked "what does this touch", "who calls X", or to audit work already called done.
---

# Change list from the coding tools

The owner asked three times (2026-11-06, 11-07, 11-08) why a change list came from grep. A list built from text search misses callers reached through imports, re-exports, interfaces, workflows and other processes. Every list goes through these steps, in order, and shows its evidence.

## 1. Name the flows, end to end

For each thing the change affects, write down:
- **Where it starts**: the frontend action (`apps/frontend/src/features/<area>/api*.ts#<function>`), or for work nobody clicks, the timer or event that starts it.
- **How it ends**, every way: success, refused, failed, still waiting, stopped. For each, what the person sees, and where: which record, which socket event, which screen or Needs attention line, which notice or email.

If a flow is not in `tests/coupling/flows.json`, add its spec. The entry is the frontend function.

## 2. Run the maps

```bash
npm run flows -- --out <scratchpad>/flows
```

Read `<scratchpad>/flows/snapshot.json`:
- `flows.<name>.files`: every file on the path, workflow starts through Koala's own starters and activities on their workers included.
- `flows.<name>.endings`: each way it ends, from the frontend function where the person sees it, with where it **meets** the flow: a record the flow writes and the ending reads, the session cookie, or a socket event. An ending that meets the flow nowhere fails `npm run flows`; either the code never tells the person, or the map is missing a link. Find which before going on.
- Since 2026-11-09 the graph follows a call through a named function type (a `ToolHandler` looked up by name) and a package's call to an interface or function type an app implements (a tool handler, an environment driver); maps made before then stop at `tool-runtime.ts` and at engine-core's calls into the backend.
- `flows.<name>.gaps`: calls the graph could not resolve, such as interfaces. Resolve each one with LSP `goToImplementation`, or name it in the list as unresolved.
- `concepts.<id>`: every implementation of a cross-cutting concept (`dependencies`, `work`, `config`, `kubeconfig`, `cluster-command`, `calls-out`, `store`, `files`). A change to a concept starts from this list, not from the places you remember.

## 3. Every symbol the change touches

For each symbol changed, moved or removed:
- `npm run refs -- <file> <Symbol>`: every import, read and write across the workspaces, through re-exports and the workspace links in `node_modules` (until 2026-11-09 it missed every app's use of a package symbol, since its language service had no `realpath`; lists built from it before then are suspect).
- The LSP tool, `findReferences`: ask from a **caller's** side (a file in the consuming workspace), since LSP answers only for the projects it has opened. Open each workspace first, for example with `documentSymbol` on one of its files.
- Tests count. A test that builds its own worker, client or store has to get the change too, or it tests the old behaviour.

## 4. Write the list for the owner

- What the person sees today, and what changes, per flow (rule 6: flow before and after).
- Each change with its `file:line`, grouped by flow or concept.
- Removals, named (rule 7: no test weakened without a yes).
- Which tool found each site. Say which tool missed something another tool found, and record that gap in memory.
- Open questions: search the owner's words first (`npm run said -- <words>`, the plans, `tests/alignment/decisions.ts`). Ask only real decisions, framed as what the person would see.

## 5. Auditing work called done

Run the same steps on the finished change: the commit's diff, its symbols through refs and LSP, its flows through the maps. Compare against what was claimed in the commit and the report. List anything the change missed: a caller, a flow ending, a test worker, a frontend line. Each gap is either fixed or reported to the owner.
