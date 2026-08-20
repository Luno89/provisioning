/**
 * Harness V2 API Routes with Conversational Orchestration & Task Proposals.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getHarnessDb } from '../db.js';
import { BudgetAllocator } from '../engine/budget-allocator.js';
import { OrchestratorChat } from '../engine/orchestrator-chat.js';
import type { HarnessTask, HarnessConversation, HarnessChatMessage } from '@koala/harness-types';
import { Connection, Client } from '@temporalio/client';
import { buildDataConverter } from '../../lib/temporal-codec.js';

import type { ModelService } from '../../services/ModelService.js';

export function createHarnessV2Router(deps: { modelService?: ModelService } = {}): Router {
  const router = Router();
  const { modelService } = deps;

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

  // ── Conversation Endpoints ────────────────────────────────────────────────
  // GET /api/harness-v2/conversations
  router.get('/conversations', async (_req, res) => {
    try {
      const db = await getHarnessDb();
      const conversations = await db.getConversations();
      res.json({ success: true, conversations });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/conversations
  router.post('/conversations', async (_req, res) => {
    try {
      const db = await getHarnessDb();
      const conversationId = `hconv-${uuidv4().slice(0, 8)}`;
      const newConversation: HarnessConversation = {
        id: conversationId,
        title: 'New Planning Session',
        messages: [
          {
            id: `msg-${uuidv4().slice(0, 8)}`,
            role: 'assistant',
            content: 'Hello! I am your Harness V2 Orchestrator. What would you like to build, research, or audit today?',
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.saveConversation(newConversation);
      res.status(201).json({ success: true, conversation: newConversation });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/harness-v2/conversations/:id
  router.get('/conversations/:id', async (req, res) => {
    try {
      const db = await getHarnessDb();
      const conversation = await db.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      }
      res.json({ success: true, conversation });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/conversations/:id/messages
  router.post('/conversations/:id/messages', async (req, res) => {
    try {
      const { content, modelId } = req.body;
      if (!content || !content.trim()) {
        res.status(400).json({ success: false, error: 'Message content is required' });
        return;
      }

      const db = await getHarnessDb();
      const conversation = await db.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      }

      const userMsg: HarnessChatMessage = {
        id: `msg-${uuidv4().slice(0, 8)}`,
        role: 'user',
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };

      await db.addMessageToConversation(conversation.id, userMsg);

      const userId = (req as any).user?.id;
      const sessionCookie = req.headers.cookie;

      // Run Orchestrator deliberation & proposal extraction with full live context
      const { message: assistantMsg, proposals } = await OrchestratorChat.processMessage(
        content.trim(),
        conversation.messages,
        {
          userId,
          sessionCookie,
          modelService,
          modelId,
        },
      );

      // Auto-update conversation title from first user prompt if default
      if (conversation.title === 'New Planning Session') {
        const generatedTitle = content.trim().length > 35
          ? `${content.trim().slice(0, 32)}...`
          : content.trim();
        conversation.title = generatedTitle;
        await db.saveConversation(conversation);
      }

      await db.addMessageToConversation(conversation.id, assistantMsg);

      res.status(201).json({
        success: true,
        userMessage: userMsg,
        assistantMessage: assistantMsg,
        proposals,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/harness-v2/conversations/:id/proposals/:proposalId/accept
  router.post('/conversations/:id/proposals/:proposalId/accept', async (req, res) => {
    try {
      const { id: conversationId, proposalId } = req.params;
      const db = await getHarnessDb();
      const conversation = await db.getConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      }

      // Find the proposal in messages
      let targetProposal = null;
      for (const m of conversation.messages) {
        if (m.proposals) {
          const match = m.proposals.find((p) => p.id === proposalId);
          if (match) {
            targetProposal = match;
            break;
          }
        }
      }

      if (!targetProposal) {
        res.status(404).json({ success: false, error: 'Proposal not found' });
        return;
      }

      const taskId = `harness-v2-${uuidv4().slice(0, 8)}`;
      const task: HarnessTask = {
        id: taskId,
        conversationId,
        title: targetProposal.title,
        description: targetProposal.description,
        personaId: targetProposal.personaId,
        phase: 'implement',
        budget: targetProposal.budget,
        status: 'running',
        checkpoints: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.saveTask(task);
      await db.updateProposalInConversation(conversationId, proposalId, 'accepted', taskId);

      // Start Temporal Workflow
      try {
        const client = await getTemporalClient();
        await client.workflow.start('HarnessTaskWorkflow', {
          taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'host-ops-queue',
          workflowId: `harness-v2-workflow-${taskId}`,
          args: [{ taskId, maxTurns: task.budget.maxTurns }],
        });
      } catch (wfErr: any) {
        console.warn(`[HarnessV2Router] Could not trigger Temporal workflow (${wfErr.message}). Task recorded in DB.`);
      }

      res.status(201).json({ success: true, task });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Task Endpoints ────────────────────────────────────────────────────────
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
      const { title, description, personaId = 'persona-coder', projectId, conversationId } = req.body;
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
        conversationId,
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
