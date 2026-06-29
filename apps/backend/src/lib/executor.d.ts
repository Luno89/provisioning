import { Server as SocketServer } from 'socket.io';
export interface ExecuteOptions {
    env?: Record<string, string> | undefined;
    onLog?: ((data: string) => void) | undefined;
    logFile?: string | undefined;
    resourceId?: string | undefined;
    io?: SocketServer | undefined;
}
export interface ExecuteResult {
    stdout: string;
    stderr: string;
    logFile: string;
}
export declare class Executor {
    private activeStreams;
    getLogPath(logId: string): string;
    deploy(stackName: string, options?: ExecuteOptions): Promise<ExecuteResult>;
    destroy(stackName: string, options?: ExecuteOptions): Promise<ExecuteResult>;
    createLocalCluster(name: string, options?: ExecuteOptions): Promise<ExecuteResult>;
    deleteLocalCluster(name: string, options?: ExecuteOptions): Promise<ExecuteResult>;
    listHelmReleases(kubeconfig: string, context?: string): Promise<any>;
    getHelmStatus(kubeconfig: string, releaseName: string, namespace: string, context?: string): Promise<string>;
    getDiagnostics(kubeconfig: string, namespace: string, context?: string): Promise<string>;
    listPods(kubeconfig: string, namespace?: string, context?: string): Promise<any>;
    streamPodLogs(resourceId: string, namespace: string, podName: string, io: SocketServer, context?: string): Promise<void>;
    stopKubeStream(resourceId: string): void;
    private runCommand;
}
//# sourceMappingURL=executor.d.ts.map