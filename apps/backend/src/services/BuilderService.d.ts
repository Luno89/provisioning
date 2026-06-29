import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
export declare class BuilderService extends BaseService {
    private infra;
    private buildContext;
    constructor(db: any, infra: InfrastructureService);
    buildCustomImage(baseImage: string, modules: string[], appType?: string, options?: any): Promise<string>;
}
//# sourceMappingURL=BuilderService.d.ts.map