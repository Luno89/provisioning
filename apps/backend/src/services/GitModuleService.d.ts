import { BaseService } from './BaseService.js';
export interface OdooModule {
    id: string;
    name: string;
    summary: string;
    description: string;
    author: string;
    version: string;
    depends?: string[];
}
export declare class GitModuleService extends BaseService {
    private getRepoPath;
    listAvailableModules(appType?: string): Promise<OdooModule[]>;
    private extractManifestValue;
    private extractManifestList;
}
//# sourceMappingURL=GitModuleService.d.ts.map