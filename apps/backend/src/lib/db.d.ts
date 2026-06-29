import type { ClusterMetadata, DeploymentMetadata } from './types.js';
export declare class LocalDB {
    private readonly isTest;
    private readonly clustersPath;
    private readonly deploymentsPath;
    init(): Promise<void>;
    private exists;
    getClusters(): Promise<ClusterMetadata[]>;
    saveCluster(cluster: ClusterMetadata): Promise<void>;
    saveClusterList(clusters: ClusterMetadata[]): Promise<void>;
    getDeployments(): Promise<DeploymentMetadata[]>;
    saveDeployment(deployment: DeploymentMetadata): Promise<void>;
    saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void>;
    /**
     * Create a new cluster entry (used by TemporalService on workflow kickoff).
     */
    saveClusterInfo(cluster: Partial<ClusterMetadata>): Promise<ClusterMetadata>;
    saveDeploymentInfo(deployment: Partial<DeploymentMetadata>): Promise<DeploymentMetadata>;
}
//# sourceMappingURL=db.d.ts.map