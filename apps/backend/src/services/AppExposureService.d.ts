import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import type { LocalDB } from '../lib/db.js';
import type { DeploymentMetadata } from '../lib/types.js';
export declare class AppExposureService extends BaseService {
    private infra;
    private clusters;
    private nginxConfDir;
    constructor(db: LocalDB, infra: InfrastructureService, clusters: ClusterService);
    private sanitize;
    private buildUpstreamTarget;
    private buildConfContent;
    expose(id: string): Promise<DeploymentMetadata>;
    syncExposedApps(): Promise<void>;
    unexpose(id: string): Promise<DeploymentMetadata>;
}
//# sourceMappingURL=AppExposureService.d.ts.map