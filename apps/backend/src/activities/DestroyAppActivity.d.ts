export interface DestroyAppArgs {
    name: string;
    clusterId: string;
    clusterName: string;
    provider: string;
    strategy: string;
    logFile: string;
}
export interface DestroyAppResult {
    status: string;
    msg: string;
}
export declare const destroyAppActivityMeta: {
    name: string;
    startToCloseTimeout: string;
};
export declare function DestroyAppActivity(args: DestroyAppArgs): Promise<DestroyAppResult>;
//# sourceMappingURL=DestroyAppActivity.d.ts.map