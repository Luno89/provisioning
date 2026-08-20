/**
 * Database access helper for Harness V2.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { HarnessTask, TurnExecutionStep } from '@koala/harness-types';

// In-memory fallback for testing environments
const memoryTasks = new Map<string, HarnessTask>();
const memoryTraces = new Map<string, TurnExecutionStep[]>();

export async function getHarnessDb() {
  const db = createDatabase() as any;
  await db.init();

  const isMongo = Boolean(db.db);

  return {
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
  };
}
