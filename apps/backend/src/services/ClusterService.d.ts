import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { LocalDB } from '../lib/db.js';
import { Server as SocketServer } from 'socket.io';
export declare class ClusterService extends BaseService {
    private infra;
    constructor(db: LocalDB, infra: InfrastructureService);
    private getRealNameservers;
    getKubeconfigPath(cluster: ClusterMetadata): Promise<string>;
    getAll(io?: SocketServer): Promise<ClusterMetadata[]>;
    getById(id: string): Promise<ClusterMetadata | undefined>;
    provision(name: string, provider: ClusterMetadata['provider'], io?: SocketServer): Promise<ClusterMetadata>;
    delete(id: string, io?: SocketServer): Promise<void>;
    listAllPods(id: string): Promise<any>;
    listReleases(id: string): Promise<any>;
}
//# sourceMappingURL=ClusterService.d.ts.map