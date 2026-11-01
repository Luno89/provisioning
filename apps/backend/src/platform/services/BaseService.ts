import type { Database } from '../lib/db-interface.js';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

export class BaseService<Db = Database> {
  protected logger = pino(pinoPretty());
  protected db: Db;

  constructor(db: Db) {
    this.db = db;
  }
}
