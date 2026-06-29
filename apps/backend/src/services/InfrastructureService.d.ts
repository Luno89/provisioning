import { Server as SocketServer } from 'socket.io';
export interface ExecuteOptions {
    env?: Record<string, string> | undefined;
    logFile?: string | undefined;
    resourceId?: string | undefined;
    io?: SocketServer | undefined;
}
/**
 * Service to handle low-level infrastructure commands.
 */
export declare class InfrastructureService {
    private activeStreams;
    getLogPath(logId: string): string;
    deploy(stackName: string, options?: ExecuteOptions): Promise<unknown>;
    destroy(stackName: string, options?: ExecuteOptions): Promise<unknown>;
    buildImage(tag: string, dockerfile: string, context: string, options?: ExecuteOptions): Promise<unknown>;
    importImage(clusterName: string, imageTag: string, options?: ExecuteOptions): Promise<unknown>;
    runKubectl(args: string[], kubeconfig?: string): Promise<string>;
    runHelm(args: string[], kubeconfig?: string): Promise<string>;
    getKubeconfig(name: string): Promise<string>;
    listLocalClusters(): Promise<string[]>;
    createLocalCluster(name: string, options?: ExecuteOptions): Promise<unknown>;
    deleteLocalCluster(name: string, options?: ExecuteOptions): Promise<unknown>;
    streamLogs(resourceId: string, args: string[], io: SocketServer, room: string, kubeconfig?: string): Promise<void>;
    stopStream(resourceId: string): void;
    private runCommand;
}
//# sourceMappingURL=InfrastructureService.d.ts.map