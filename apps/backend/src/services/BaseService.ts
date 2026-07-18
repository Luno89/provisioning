import type { Database } from '../lib/db-interface.js';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

export class BaseService {
  protected logger = pino(pinoPretty());
  protected db: Database;

  constructor(db: Database) {
    this.db = db;
  }
}
