import type { LocalDB } from '../lib/db.js';
import pino from 'pino';
export declare class BaseService {
    protected logger: pino.Logger<never, boolean>;
    protected db: LocalDB;
    constructor(db: LocalDB);
}
//# sourceMappingURL=BaseService.d.ts.map