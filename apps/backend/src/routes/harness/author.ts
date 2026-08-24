import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { v4 as uuidv4 } from 'uuid';
import { buildModelRequest } from '../../lib/model-request.js';
import {
  buildTaskAuthorPrompt, extractTaskProposals, stripTaskBlock,
  AUTHORING_SAMPLING, AUTHORING_MAX_TOKENS, normaliseTasks, taskFiles,
} from '../../lib/experiment-authoring.js';
import { MAX_TASKS, MAX_TASK_CHARS } from '../../lib/experiments.js';
import { resolveConfig } from '../../lib/personas.js';
import { isWorkspaceLanguage } from '../../lib/workspace-spec.js';
import type { ExperimentTask } from '@koala/harness-types';
import type { ModelService } from '../../services/ModelService.js';
import { acceptedTasks, type AuthoringService } from '../../services/AuthoringService.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Koala proposes an experiment suite; the sandbox proves each task can actually be verified.
 *
 * Extracted from index.ts, where `/api/harness/*` was 34 routes on one `app` object.
 */
export interface authorRouterDeps {
  db: Database;
  modelService: ModelService; authoringService: AuthoringService; modelIdsFor: (u: string) => Promise<string[] | undefined>;
}

export function authorRouter(deps: authorRouterDeps): Router {
  const { db, modelService, authoringService, modelIdsFor } = deps;
  const router = Router();

  /** ── AUTHORING — Koala proposes the suite, the sandbox proves the verify commands ── */

  /**
   * Asks Koala for tasks. Proposals only — nothing is stored and nothing runs.
   *
   * Reasoning is OFF here, unlike the planning chat. Authoring is one-shot structured output, and
   * measured on this prompt with reasoning on the model produced 16,664 characters of deliberation,
   * hit the token ceiling and emitted no answer at all.
   */
  router.post('/tasks', async (req, res) => {
    const { goal, existing, modelId } = req.body ?? {};
    if (!String(goal ?? '').trim()) return res.status(400).json({ error: 'Say what the suite should test.' });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(userOf(req).id, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    try {
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        /**
         * Built through the shared builder, and honouring an adopted profile.
         *
         * This route spread `conversationSampling` and then its own bag by hand — the exact pattern
         * the builder exists to delete. It meant an adopted profile did not apply here (so a
         * configuration promoted from an experiment reached leaves and chat but not the authoring
         * that produces the next experiment), and any knob set on it would have gone out at the top
         * level regardless of where the engine actually reads it.
         *
         * Profile only, no persona, and that is deliberate: this is the Lab writing a test suite,
         * not a persona doing its job. `AUTHORING_SAMPLING` is applied last as a floor rather than a
         * default — reasoning off is not a preference here, it is what makes the route work at all
         * (measured: with it on, 16,664 characters of deliberation, the token ceiling hit, and no
         * answer emitted).
         */
        body: JSON.stringify(buildModelRequest({
          turn: 'conversation',
          ...(provider.kind ? { kind: provider.kind } : {}),
          ...(provider.model ? { model: provider.model } : {}),
          messages: [
            {
              role: 'system',
              content: buildTaskAuthorPrompt(
                Array.isArray(existing) ? { existing: existing.map((n: unknown) => String(n)) } : {},
              ),
            },
            { role: 'user', content: String(goal).slice(0, 2000) },
          ],
          stream: false,
          maxTokens: AUTHORING_MAX_TOKENS,
          overrides: resolveConfig(await db.getHarnessProfile(userOf(req).id), null).overrides,
          extra: AUTHORING_SAMPLING,
        }).body),
      });

      if (!upstream.ok) {
        return res.status(502).json({ error: `Model call failed (${upstream.status})` });
      }
      const body: any = await upstream.json();
      const reply = body?.choices?.[0]?.message?.content ?? '';
      const { tasks, rejected } = extractTaskProposals(reply);

      // The prose without the payload — the tasks are rendered as cards, so leaving the JSON in
      // would show the same thing twice.
      res.json({ tasks, rejected, note: stripTaskBlock(reply) });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err).slice(0, 300) });
    }
  });

  /**
   * Runs each proposed verify command in an empty sandbox and requires it to FAIL.
   *
   * The gate that matters. A command that passes where no work has been done passes always, so a
   * suite built from such commands scores every variant a winner — the exact failure the Lab
   * exists to catch, produced automatically. One sandbox for the batch; see AuthoringService.
   */
  router.post('/validate', async (req, res) => {
    const { tasks } = req.body ?? {};
    if (!Array.isArray(tasks) || !tasks.length) {
      return res.status(400).json({ error: 'Nothing to validate.' });
    }
    if (tasks.length > MAX_TASKS) {
      return res.status(400).json({ error: `At most ${MAX_TASKS} tasks in a suite.` });
    }

    try {
      const validated = await authoringService.validateOnEmptyWorkspace(
        userOf(req).id,
        // Through `normaliseTasks` rather than a second hand-written mapping. The duplicate here
        // silently dropped seed and solution, so the gate validated a task with neither and
        // reported it fine — the exact class of silent drop the gate exists to catch.
        normaliseTasks(tasks),
      );
      res.json({ tasks: validated, accepted: acceptedTasks(validated) });
    } catch (err: any) {
      // A cluster problem is not a verdict on the commands — saying otherwise would reject good
      // tasks for a reason that has nothing to do with them.
      res.status(503).json({ error: `Could not reach a sandbox: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  });

  /**
   * The configuration as a file you can commit.
   *
   * Makes git available without making it load-bearing: the running system keeps reading from the
   * database, and this is the artifact to review, share or restore. Carries suite DEFINITIONS and
   * adopted defaults — never results, which mean nothing on another machine.
   */
  return router;
}
