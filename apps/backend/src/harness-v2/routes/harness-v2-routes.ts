/**
 * Harness V2 API Routes.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../../lib/db-interface.js';
import { BudgetAllocator } from '../engine/budget-allocator.js';
import type { HarnessTask } from '@koala/harness-types';
import { Connection, Client } from '@temporalio/client';
import { buildDataConverter } from '../../lib/temporal-codec.js';

export function createHarnessV2Router(): Router {
  const router = Router();

  // Helper to connect to Temporal Client
  async function getTemporalClient() {
    const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
    const connection = await Connection.connect({ address });
    const dataConverter = buildDataConverter(process.env.JWT_SECRET);
    return new Client({
      connection,
      ...(dataConverter ? { dataConverter } : {}),
    });
  }

  // GET /api/harness-v2/tasks
  router.get('/tasks', async (_req, res) => {
    try {
      const db = await getHarnessDb();
      const tasks = await db.getTasks();
      res.json({ success: true, tasks });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/tasks
  router.post('/tasks', async (req, res) => {
    try {
      const { title, description, personaId = 'persona-coder', projectId } = req.body;
      if (!title) {
        res.status(400).json({ success: false, error: 'Title is required' });
        return;
      }

      const db = await getHarnessDb();
      const budget = BudgetAllocator.estimateBudget(title, description || '');
      const taskId = `harness-v2-${uuidv4().slice(0, 8)}`;

      const task: HarnessTask = {
        id: taskId,
        projectId,
        title,
        description: description || '',
        personaId,
        phase: 'implement',
        budget,
        status: 'running',
        checkpoints: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.saveTask(task);

      // Start Temporal Workflow asynchronously
      try {
        const client = await getTemporalClient();
        await client.workflow.start('HarnessTaskWorkflow', {
          taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'host-ops-queue',
          workflowId: `harness-v2-workflow-${taskId}`,
          args: [{ taskId, maxTurns: budget.maxTurns }],
        });
      } catch (wfErr: any) {
        console.warn(`[HarnessV2Router] Could not trigger Temporal workflow (${wfErr.message}). Task recorded in DB.`);
      }

      res.status(201).json({ success: true, task });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/harness-v2/tasks/:id
  router.get('/tasks/:id', async (req, res) => {
    try {
      const db = await getHarnessDb();
      const task = await db.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }
      res.json({ success: true, task });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/harness-v2/tasks/:id/traces
  router.get('/tasks/:id/traces', async (req, res) => {
    try {
      const db = await getHarnessDb();
      const traces = await db.getTraces(req.params.id);
      res.json({ success: true, traces });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/tasks/:id/pause
  router.post('/tasks/:id/pause', async (req, res) => {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(`harness-v2-workflow-${req.params.id}`);
      await handle.signal('pause');

      const db = await getHarnessDb();
      await db.updateTask(req.params.id, { status: 'paused' });

      res.json({ success: true, status: 'paused' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/tasks/:id/resume
  router.post('/tasks/:id/resume', async (req, res) => {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(`harness-v2-workflow-${req.params.id}`);
      await handle.signal('resume');

      const db = await getHarnessDb();
      await db.updateTask(req.params.id, { status: 'running' });

      res.json({ success: true, status: 'running' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
