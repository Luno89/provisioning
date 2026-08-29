import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { v4 as uuidv4 } from 'uuid';
import {
  expandAxes, normaliseExperiment, validateExperiment, summariseExperiment,
  latestResults, plannedRuns, experimentTasks, MAX_REPEATS, MAX_TASK_CHARS,
} from '../../lib/experiments.js';
import { normaliseTasks, taskFiles, unknownPersona } from '../../lib/experiment-authoring.js';
import { isWorkspaceLanguage } from '../../lib/workspace-spec.js';
import type { Experiment, ExperimentTask } from '@koala/harness-types';
import type { ExperimentService } from '../../services/ExperimentService.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface experimentsRouterDeps {
  db: Database;
  experimentService: ExperimentService; modelIdsFor: (u: string) => Promise<string[] | undefined>;
}

export function experimentsRouter(deps: experimentsRouterDeps): Router {
  const { db, experimentService, modelIdsFor } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const mine = (await db.getExperiments()).filter((e) => e.ownerId === userOf(req).id);
    res.json(
      mine
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((e) => ({ ...summariseExperiment(e), running: experimentService.isRunning(e.id) })),
    );
  });

  router.get('/:id', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    res.json({ ...normaliseExperiment(experiment), running: experimentService.isRunning(experiment.id) });
  });

  router.post('/', async (req, res) => {
    const { name, tasks, task, verifyCommand, language, variants, axes, repeats } = req.body ?? {};
    const resolved = Array.isArray(variants) && variants.length
      ? variants
      : expandAxes(axes && typeof axes === 'object' ? axes : {});

    const suite: ExperimentTask[] = Array.isArray(tasks) && tasks.length
      ? normaliseTasks(tasks)
      : [{
          id: 't1',
          name: 'Task',
          prompt: String(task ?? '').slice(0, MAX_TASK_CHARS),
          verifyCommand: String(verifyCommand ?? '').trim().slice(0, 2000),
        }];

    const draft: Experiment = {
      id: uuidv4(),
      ownerId: userOf(req).id,
      name: String(name ?? '').trim().slice(0, 120),
      tasks: suite,
      language: isWorkspaceLanguage(language) ? language : 'node',
      variants: resolved,
      repeats: Math.max(1, Math.min(MAX_REPEATS, Number(repeats) || 1)),
      status: 'draft',
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const invalid = validateExperiment(draft);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveExperiment(draft);
    res.status(201).json(draft);
  });

  router.put('/:id', async (req, res) => {
    const existing = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!existing) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(existing.id)) {
      return res.status(409).json({ error: 'Still running — wait for it to finish before editing.' });
    }

    const { name, tasks, variants, axes, repeats } = req.body ?? {};
    const before = experimentTasks(existing);
    const suite = Array.isArray(tasks) && tasks.length ? normaliseTasks(tasks) : before;
    const badPersona = await unknownPersona(db, userOf(req).id, variants);
    if (badPersona) return res.status(400).json({ error: badPersona });

    const resolvedVariants = Array.isArray(variants) && variants.length
      ? variants
      : axes && typeof axes === 'object'
        ? expandAxes(axes)
        : existing.variants;

    const next: Experiment = {
      ...existing,
      name: name === undefined ? existing.name : String(name).trim().slice(0, 120),
      tasks: suite,
      variants: resolvedVariants,
      repeats: repeats === undefined
        ? existing.repeats
        : Math.max(1, Math.min(MAX_REPEATS, Number(repeats) || 1)),
      updatedAt: new Date().toISOString(),
    };

    const invalid = validateExperiment(next);
    if (invalid) return res.status(400).json({ error: invalid });

    const changedTasks = suite
      .filter((t) => {
        const was = before.find((b) => b.id === t.id);
        return !was || was.prompt !== t.prompt || was.verifyCommand !== t.verifyCommand;
      })
      .map((t) => t.name);
    const variantsChanged = JSON.stringify(resolvedVariants) !== JSON.stringify(existing.variants);

    await db.saveExperiment(next);
    res.json({
      ...next,
      changedTasks,
      variantsChanged,
      priorRuns: (existing.runs?.length ?? 0) || (latestResults(existing).length ? 1 : 0),
    });
  });

  router.post('/:id/duplicate', async (req, res) => {
    const existing = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!existing) return res.status(404).json({ error: 'No such experiment' });

    const now = new Date().toISOString();
    const copy: Experiment = {
      ...existing,
      id: uuidv4(),
      name: `${existing.name} (copy)`.slice(0, 120),
      tasks: experimentTasks(existing),
      status: 'draft',
      results: [],
      progress: undefined,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await db.saveExperiment(copy);
    res.status(201).json(copy);
  });

  router.post('/:id/run', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      return res.status(409).json({ error: 'Already running' });
    }

    experimentService.start(experiment);
    res.status(202).json({ started: true, runs: plannedRuns(experiment) });
  });

  router.post('/:id/stop', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      experimentService.stop(experiment.id);
    }
    const runs = (experiment as any).runs ?? [];
    const updatedRuns = runs.map((r: any) => ({
      ...r,
      status: r.status === 'running' ? 'complete' : r.status,
      finishedAt: r.finishedAt || new Date().toISOString(),
    }));
    await db.saveExperiment({
      ...experiment,
      status: experiment.results?.length || updatedRuns.some((r: any) => r.results?.length) ? 'complete' : 'draft',
      runs: updatedRuns,
      progress: undefined,
      updatedAt: new Date().toISOString(),
    });
    res.json({ stopped: true });
  });

  router.delete('/:id', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === idOf(req) && e.ownerId === userOf(req).id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      experimentService.stop(experiment.id);
    }
    await db.deleteExperiment(experiment.id);
    res.json({ deleted: true });
  });

  return router;
}
