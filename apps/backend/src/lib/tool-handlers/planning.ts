import { runPlanningTool } from '../leaf-tool-runner.js';
import { json, type ToolEntry, type ToolNeed, type ToolRuntime } from '../tool-runtime.js';

/**
 * The planning tools, as registry entries.
 *
 * They share one implementation -- `runPlanningTool` -- because they share the branch resolution
 * and the leaf bookkeeping. What differs per tool, and what the registry acts on, is `needs`.
 */
const entry = (name: string, needs: readonly ToolNeed[]): ToolEntry => ({
  needs,
  run: async (rt: ToolRuntime, args) => ({ content: await runPlanningTool(rt, name, args) }),
});

const OWNS: Record<string, readonly ToolNeed[]> = {
  list_leaves: [],
  get_leaf: [],
  list_personas: [],
  update_leaf_memory: [],
  set_acceptance: [],
  propose_leaf: ['projects'],
  revise_leaf: [],
  withdraw_leaf: [],
  replace_leaf: [],
  list_projects: ['projects'],
  create_project: ['projects'],
  set_leaf_project: ['projects'],
  write_plan_document: ['projects'],
  // Not `['mcpRegistry']`: its own refusal says "do not conclude there are none",
  // which a generic "needs the MCP registry" would throw away.
  list_mcp_servers: [],
  start_ingest: ['ingest'],
  ingest_status: ['ingest'],
  search_corpus: ['ingest'],
};

export const PLANNING_ENTRIES: Record<string, ToolEntry> = {
  ...Object.fromEntries(Object.entries(OWNS).map(([name, needs]) => [name, entry(name, needs)])),

  /**
   * Research is a sub-agent, not a database call, so the runtime supplies it rather than this
   * module. It was a schema synthesised inside `planning-turn.ts` and intercepted before dispatch;
   * it is an ordinary catalogue row with an ordinary handler now.
   */
  research: {
    // Not `['research']`: "unavailable on this run, plan with what you know" tells a planner what
    // to do next, and the generic "needs a research agent" does not.
    needs: [],
    run: async (rt, args) => {
      if (!rt.research) {
        return json({ error: 'Research is unavailable on this run. Plan with what you know.' });
      }
      const questions = Array.isArray(args.questions) ? args.questions.map(String).filter(Boolean) : [];
      if (!questions.length) return json({ error: 'Give one or more specific questions.' });
      const findings = await rt.research(questions);
      return json({
        findings: findings.map((f) => ({ question: f.question, answer: f.findings, sources: f.sources })),
      });
    },
  },
};
