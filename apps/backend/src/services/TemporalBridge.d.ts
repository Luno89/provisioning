/**
 * Temporal Bridge - bridges Express routes ↔ Temporal workflow execution.
 *
 * All provisioning / deployment mutations go through this bridge, replacing the
 * original inline setTimeout() loops with Temporal's workflow persistence engine.
 */
import { Client } from '@temporalio/client';
import { LocalDB } from './lib/db';
import type { ClusterMetadata, DeploymentMetadata } from './lib/types';
export declare const connectToTemporal: (address: string) => Promise<Client>;
export declare class TemporalBridge {
    readonly client: Client;
    private _initialized;
    private db;
    constructor(db: LocalDB);
    isInitialized(): boolean;
    start(): Promise<this>;
    flush(): Promise<void>;
    stop(): Promise<void>;
    waitForStatus(workflowId: string): Promise<ClusterMetadata | DeploymentMetadata>;
    provision(clusterName: string, provider: string): Promise<WorkflowDeal>;
    destroyCluster(clusterId: string): Promise<WorkflowDeal>;
    onClusterStatus(query: any): Promise<ClusterMetadata[]>;
    deployApp(args: any): Promise<WorkflowDeal>;
    destroyApp(deploymentId: string): Promise<WorkflowDeal>;
    resizeDisk(id: string, storage: Record<string, string>): Promise<WorkflowDeal>;
}
//# sourceMappingURL=TemporalBridge.d.ts.map