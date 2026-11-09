import type { Collection, Db } from 'mongodb';
import { Records } from './platform/lib/collection.js';
import { watchWrites } from './platform/lib/change-streams.js';

async function put(collection: Collection, id: string): Promise<void> {
  await collection.replaceOne({ _id: id as never }, { id }, { upsert: true });
}

export class Store {
  private readonly notes = new Records<{ id: string }>(() => this.db, 'notes');

  constructor(private readonly db: Db) {}

  private get trees(): Collection {
    return this.db.collection('trees');
  }

  async getTrees(): Promise<unknown[]> {
    return this.trees.find({}).toArray();
  }

  async saveTree(id: string): Promise<void> {
    await put(this.trees, id);
  }

  async saveRun(id: string): Promise<void> {
    await this.db.collection('runs').insertOne({ id });
  }

  async named(name: string): Promise<void> {
    await this.db.collection(name).deleteOne({});
  }

  async listNotes(): Promise<unknown[]> {
    return this.notes.all();
  }

  async saveNote(id: string): Promise<void> {
    await this.notes.put({ id });
  }

  async notesRaw(): Promise<number> {
    return this.notes.raw.countDocuments({});
  }

  follow(): void {
    watchWrites(() => this.trees, () => undefined);
  }
}
