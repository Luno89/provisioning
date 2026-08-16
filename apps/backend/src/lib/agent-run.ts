/**
 * Turning a persona and a sandbox into the options an agent run needs.
 *
 * ── WHY THIS EXISTS ──
 * Three places call `runAgentLoop`, and each assembled its arguments by hand: the leaf activity, the
 * landing-conflict resolver, and the Lab. Hand-maintained lists of the same thing drift, and this
 * one drifted in every direction at once.
 *
 * The Lab passed no step budget, no pacing and no toolset, so every arm ran forty steps and was
 * told to "commit and push what you have NOW" inside a sandbox with no repository — misleading
 * advice in every run of every experiment, for as long as the Lab had existed. The landing resolver
 * passes no memory. And editing the leaf's list dropped `overrides` and `memoryContext` outright,
 * which would have discarded the entire promoted profile and the memory bank on every leaf; five
 * tests caught it, which is luck as much as design.
 *
 * ── WHAT BELONGS HERE AND WHAT DOES NOT ──
 * This assembles the parts that are the SAME question everywhere: what the agent may use, how long
 * it has, what it is told as time runs out, and which knobs are set. It does not decide the task,
 * the sandbox driver or the model — those genuinely differ per caller, so they stay arguments.
 */
import type { Persona } from '@koala/harness-types';
import type { AgentRunOptions, SandboxDriver } from './agent-loop.js';
import type { WebTools } from './web-tools.js';
import type { Overrides } from './tunables.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';

/** Everything the caller knows that the persona cannot. */
export interface RunInputs {
  taskContext: string;
  sandbox: SandboxDriver;
  overrides: Overrides;
  memoryContext?: string | undefined;
  /**
   * Built by the caller because it needs a database and a cluster; OFFERED only if the persona asks
   * for it. Supplying tools a persona did not list simply wastes the resolution.
   */
  web?: WebTools | undefined;
  fromProfile?: string[] | undefined;
  fromPersona?: string[] | undefined;
}

/** Whether this persona's declared toolset includes a way to reach the web. */
export function wantsWeb(persona: Pick<Persona, 'scope'> | null | undefined): boolean {
  const tools = persona?.scope?.tools ?? [];
  return tools.some((t) => (WEB_TOOL_NAMES as readonly string[]).includes(t));
}

/**
 * The options an agent run should be given.
 *
 * Every environment decision is read off the persona: the toolset, the budget, the pacing, the
 * withdrawal. A persona that declares none of them leaves the loop's own defaults intact, which is
 * what every run did before personas owned their environment.
 */
export function agentRunOptions(
  persona: Pick<Persona, 'scope'> | null | undefined,
  inputs: RunInputs,
): Omit<AgentRunOptions, 'baseUrl' | 'model'> {
  const run = persona?.scope?.run ?? {};
  const tools = persona?.scope?.tools ?? [];

  return {
    taskContext: inputs.taskContext,
    sandbox: inputs.sandbox,
    overrides: inputs.overrides,
    ...(inputs.memoryContext ? { memoryContext: inputs.memoryContext } : {}),
    ...(inputs.fromProfile?.length ? { fromProfile: inputs.fromProfile } : {}),
    ...(inputs.fromPersona?.length ? { fromPersona: inputs.fromPersona } : {}),
    // Offered only when the persona asked and the caller could build them. Two conditions because
    // either one alone has been wrong: a flag with nothing wired behind it is how the Lab spent a
    // run reporting it had no internet access.
    ...(inputs.web && wantsWeb(persona) ? { web: inputs.web } : {}),
    ...(tools.length ? { allowTools: tools } : {}),
    ...(run.maxSteps ? { maxSteps: run.maxSteps } : {}),
    // The bound that corresponds to a cost. A persona sets it where the work genuinely warrants a
    // different ceiling; otherwise the loop's own applies.
    ...(run.maxTokens ? { maxTokens: run.maxTokens } : {}),
    ...(run.pacing?.length ? { pacing: run.pacing } : {}),
    ...(run.withdraw
      ? { withdrawTools: { afterStep: run.withdraw.afterStep, names: run.withdraw.tools } }
      : {}),
  };
}
