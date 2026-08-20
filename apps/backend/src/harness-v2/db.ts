/**
 * Database access helper for Harness V2.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { HarnessTask, TurnExecutionStep, HarnessConversation, HarnessChatMessage, ProposedHarnessTask } from '@koala/harness-types';

// In-memory fallback for testing environments
const memoryTasks = new Map<string, HarnessTask>();
const memoryTraces = new Map<string, TurnExecutionStep[]>();
const memoryConversations = new Map<string, HarnessConversation>();

export async function getHarnessDb() {
  const db = createDatabase() as any;
  await db.init();

  const isMongo = Boolean(db.db);

  return {
    // ── Task Operations ───────────────────────────────────────────────────
    async getTasks(): Promise<HarnessTask[]> {
      if (isMongo) {
        return db.db.collection('harness_v2_tasks').find({}).sort({ createdAt: -1 }).toArray();
      }
      return Array.from(memoryTasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async getTask(id: string): Promise<HarnessTask | null> {
      if (isMongo) {
        return db.db.collection('harness_v2_tasks').findOne({ id });
      }
      return memoryTasks.get(id) || null;
    },

    async saveTask(task: HarnessTask): Promise<void> {
      if (isMongo) {
        await db.db.collection('harness_v2_tasks').updateOne(
          { id: task.id },
          { $set: task },
          { upsert: true },
        );
      } else {
        memoryTasks.set(task.id, task);
      }
    },

    async updateTask(id: string, update: Partial<HarnessTask> | Record<string, any>): Promise<void> {
      if (isMongo) {
        await db.db.collection('harness_v2_tasks').updateOne({ id }, { $set: update });
      } else {
        const existing = memoryTasks.get(id);
        if (existing) {
          memoryTasks.set(id, { ...existing, ...update } as HarnessTask);
        }
      }
    },

    // ── Trace Operations ──────────────────────────────────────────────────
    async addTrace(taskId: string, step: TurnExecutionStep): Promise<void> {
      if (isMongo) {
        await db.db.collection('harness_v2_traces').insertOne({
          taskId,
          step,
          createdAt: new Date(),
        });
      } else {
        const current = memoryTraces.get(taskId) || [];
        current.push(step);
        memoryTraces.set(taskId, current);
      }
    },

    async getTraces(taskId: string): Promise<TurnExecutionStep[]> {
      if (isMongo) {
        const docs = await db.db.collection('harness_v2_traces')
          .find({ taskId })
          .sort({ 'step.turnIndex': 1 })
          .toArray();
        return docs.map((d: any) => d.step);
      }
      return memoryTraces.get(taskId) || [];
    },

    // ── Conversation & Proposal Operations ────────────────────────────────
    async getConversations(): Promise<HarnessConversation[]> {
      if (isMongo) {
        return db.db.collection('harness_v2_conversations').find({}).sort({ updatedAt: -1 }).toArray();
      }
      return Array.from(memoryConversations.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getConversation(id: string): Promise<HarnessConversation | null> {
      if (isMongo) {
        return db.db.collection('harness_v2_conversations').findOne({ id });
      }
      return memoryConversations.get(id) || null;
    },

    async saveConversation(conversation: HarnessConversation): Promise<void> {
      if (isMongo) {
        await db.db.collection('harness_v2_conversations').updateOne(
          { id: conversation.id },
          { $set: conversation },
          { upsert: true },
        );
      } else {
        memoryConversations.set(conversation.id, conversation);
      }
    },

    async addMessageToConversation(conversationId: string, message: HarnessChatMessage): Promise<void> {
      if (isMongo) {
        await db.db.collection('harness_v2_conversations').updateOne(
          { id: conversationId },
          {
            $push: { messages: message },
            $set: { updatedAt: new Date().toISOString() },
          },
        );
      } else {
        const conv = memoryConversations.get(conversationId);
        if (conv) {
          conv.messages.push(message);
          conv.updatedAt = new Date().toISOString();
          memoryConversations.set(conversationId, conv);
        }
      }
    },

    async updateProposalInConversation(
      conversationId: string,
      proposalId: string,
      status: 'accepted' | 'rejected',
      taskId?: string,
    ): Promise<ProposedHarnessTask | null> {
      const conv = await this.getConversation(conversationId);
      if (!conv) return null;

      let foundProposal: ProposedHarnessTask | null = null;

      for (const msg of conv.messages) {
        if (msg.proposals) {
          for (const p of msg.proposals) {
            if (p.id === proposalId) {
              p.status = status;
              if (taskId) p.taskId = taskId;
              foundProposal = p;
            }
          }
        }
      }

      if (foundProposal) {
        if (taskId) conv.activeTaskId = taskId;
        await this.saveConversation(conv);
      }

      return foundProposal;
    },
  };
}
