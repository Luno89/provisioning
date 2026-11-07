import { Readable } from 'node:stream';
import { ObjectMissing, type ObjectStore } from '../services/ObjectStore.js';

export class MemoryObjectStore implements ObjectStore {
  readonly kept = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(id: string, body: Readable, size: number | undefined, contentType: string): Promise<void> {
    const parts: Buffer[] = [];
    for await (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as string));
    const bytes = Buffer.concat(parts);
    if (size !== undefined && bytes.length !== size) throw new Error(`file ${id} was said to be ${size} bytes and ${bytes.length} arrived`);
    this.kept.set(id, { bytes, contentType });
  }

  async get(id: string): Promise<Readable> {
    const kept = this.kept.get(id);
    if (!kept) throw new ObjectMissing(id);
    return Readable.from([Buffer.from(kept.bytes)]);
  }

  async stat(id: string): Promise<{ size: number } | undefined> {
    const kept = this.kept.get(id);
    return kept ? { size: kept.bytes.length } : undefined;
  }

  async remove(id: string): Promise<void> {
    this.kept.delete(id);
  }

  async *ids(): AsyncIterable<string> {
    for (const id of [...this.kept.keys()]) yield id;
  }
}
