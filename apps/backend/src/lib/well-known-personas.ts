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
