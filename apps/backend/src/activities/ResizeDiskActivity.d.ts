export interface ResizeDiskArgs {
    name: string;
    clusterId: string;
    clusterName: string;
    provider: string;
    strategy: string;
    appType: string;
    storage: Record<string, string>;
    logFile: string;
}
export interface ResizeDiskResult {
    status: string;
    msg: string;
}
export declare const resizeDiskActivityMeta: {
    name: string;
    startToCloseTimeout: string;
};
export declare function ResizeDiskActivity(args: ResizeDiskArgs): Promise<ResizeDiskResult>;
//# sourceMappingURL=ResizeDiskActivity.d.ts.map