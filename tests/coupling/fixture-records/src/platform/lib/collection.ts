import type { Db } from 'mongodb';

export class Records<T extends { id: string }> {
  constructor(private readonly db: () => Db, readonly name: string) {}

  get raw() {
    return this.db().collection(this.name);
  }

  async all(): Promise<T[]> {
    return (await this.raw.find({}).toArray()) as unknown as T[];
  }

  async put(entity: T): Promise<void> {
    await this.raw.replaceOne({ _id: entity.id as never }, entity, { upsert: true });
  }
}
