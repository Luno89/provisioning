# Audit: AgentRunWorkflow.integration.test.ts (2026-11-21)

## What failed
"runs the shipped procedure as the Antigravity agent" failed twice, both times the same way: the run stopped with "memories are
recalled to fit a model's context, and this run names no model". Nothing about it was timing or shared state.

## The cause
Recall by meaning (engine review D6, step 3) fills the model's context with the most relevant memories, and ruling 1 makes a
model that reports no context size an error rather than a guessed size. The external agent's procedures used the same Recall
Memory node, but an external coding agent runs its own loop, manages its own context and reports no window, so there was no size
to fill. The code had one model of recall for two kinds of agent.

## The fix
The owner's ruling (2026-11-21, "Yeah 2 sounds alirght"): Koala's own agents get memories recalled to fill their model's context;
an external coding agent is told at its start what memory holds for the task and looks memories up itself through
search_memories. The external agents' procedures use the Point to Memories node, which names the relevant memories by title and
needs no context size, and the Antigravity agent holds search_memories. The test now also asserts that the agent is served
search_memories and is told the memory's title, not its text.
