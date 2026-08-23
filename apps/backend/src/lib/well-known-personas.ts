/**
 * Persona names the platform itself depends on.
 *
 * ── WHY A CONSTANT AND NOT A LOOKUP BY ROLE ──
 * Some work is not the user's to assign: resolving a merge conflict happens because leaves landed,
 * not because anyone planned it. It still runs as a persona, so its environment stays a record
 * somebody can read and edit — but the code has to be able to find that record, and a name is the
 * only stable handle a seeded record has.
 *
 * Deliberately NOT in the seed script. That script runs `main()` on import and exits the process
 * when it finishes, so importing a constant from it inside an activity would re-seed the database
 * and kill the worker.
 */

/** Resolves conflicts when leaves land on the default branch. Needs git, so needs run_command. */
export const MERGER_PERSONA = 'Merger';

/**
 * Reads a failed leaf and says why it failed.
 *
 * Its own persona rather than reusing the planner: framing work and diagnosing a failure want
 * opposite instincts — one proposes, the other refuses to conclude past the evidence. It also runs
 * with no tools at all, which is deliberate. A reviewer that could poke the sandbox would go
 * looking instead of reading, and everything it needs is already in the record.
 */
export const REVIEWER_PERSONA = 'Reviewer';

/**
 * Reads what a leaf actually produced and says whether the claim holds up.
 *
 * Its own persona rather than reusing the Reviewer, though the two are close: the Reviewer explains
 * a FAILURE and this examines a SUCCESS nothing checked. Different instincts — one is looking for a
 * cause, the other is refusing to take a claim at face value — and different questions, so they get
 * different prompts.
 *
 * Runs with no tools, for the same reason the Reviewer does. Everything it needs was captured
 * before the sandbox was destroyed (see lib/leaf-evidence.ts), and a judge that could go looking
 * would go looking instead of reading.
 */
export const JUDGE_PERSONA = 'Judge';
