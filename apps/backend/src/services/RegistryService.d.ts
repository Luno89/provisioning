import { BaseService } from './BaseService.js';
import type { LocalDB } from '../lib/db.js';
export declare class RegistryService extends BaseService {
    constructor(db: LocalDB);
    private FALLBACK_TAGS;
    search(query: string): Promise<any>;
    getTags(repo: string): Promise<any>;
}
//# sourceMappingURL=RegistryService.d.ts.map