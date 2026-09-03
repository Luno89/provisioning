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
import type { ExperimentTask } from '@koala/harness-types';
import type { ModelService } from '../../services/ModelService.js';
import { acceptedTasks, type AuthoringService } from '../../services/AuthoringService.js';
import { WorkspaceImageService } from '../../services/WorkspaceImageService.js';
import { withBuiltIns } from '../../lib/ownership.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface authorRouterDeps {
  db: Database;
  modelService: ModelService; authoringService: AuthoringService; modelIdsFor: (u: string) => Promise<string[] | undefined>;
}

export function authorRouter(deps: authorRouterDeps): Router {
  const { db, modelService, authoringService, modelIdsFor } = deps;
  const router = Router();

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
      const sampling = withBuiltIns(await db.getPersonaPacks(), userOf(req).id, (p) => p.slug)
        .find((p) => p.slug === 'koala')?.sampling;
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildModelRequest({
          turn: 'conversation',
          ...(sampling ? { sampling } : {}),
          ...(provider.kind ? { kind: provider.kind } : {}),
          ...(provider.model ? { model: provider.model } : {}),
          messages: [
            {
              role: 'system',
              content: buildTaskAuthorPrompt(
                await new WorkspaceImageService(db).list(userOf(req).id),
                Array.isArray(existing) ? { existing: existing.map((n: unknown) => String(n)) } : {},
              ),
            },
            { role: 'user', content: String(goal).slice(0, 2000) },
          ],
          stream: false,
          maxTokens: AUTHORING_MAX_TOKENS,
          extra: AUTHORING_SAMPLING,
        }).body),
      });

      if (!upstream.ok) {
        return res.status(502).json({ error: `Model call failed (${upstream.status})` });
      }
      const body: any = await upstream.json();
      const reply = body?.choices?.[0]?.message?.content ?? '';
      const { tasks, rejected } = extractTaskProposals(
        await new WorkspaceImageService(db).list(userOf(req).id),
        reply,
      );

      res.json({ tasks, rejected, note: stripTaskBlock(reply) });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err).slice(0, 300) });
    }
  });

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
        normaliseTasks(await new WorkspaceImageService(db).list(userOf(req).id), tasks),
        undefined,
        await new WorkspaceImageService(db).list(userOf(req).id),
      );
      res.json({ tasks: validated, accepted: acceptedTasks(validated) });
    } catch (err: any) {
      res.status(503).json({ error: `Could not reach a sandbox: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  });

  return router;
}
