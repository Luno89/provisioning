import type { LocalDB } from '../lib/db.js';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

export class BaseService {
  protected logger = pino(pinoPretty());
  protected db: LocalDB;

  constructor(db: LocalDB) {
    this.db = db;
  }
}
