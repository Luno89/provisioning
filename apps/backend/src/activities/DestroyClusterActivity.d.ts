export interface DestroyClusterArgs {
    name: string;
    provider: string;
    logFile: string;
}
export interface DestroyClusterResult {
    status: string;
    msg: string;
}
export declare const destroyClusterActivityMeta: {
    name: string;
    startToCloseTimeout: string;
};
export declare function DestroyClusterActivity(args: DestroyClusterArgs): Promise<DestroyClusterResult>;
//# sourceMappingURL=DestroyClusterActivity.d.ts.map