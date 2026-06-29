export interface ProvisionClusterArgs {
    name: string;
    provider: string;
    logFile: string;
}
export interface ProvisionClusterResult {
    status: string;
    kubeconfigPath: string;
    msg: string;
    logFile: string;
}
export declare const provisionClusterActivityMeta: {
    name: string;
    startToCloseTimeout: string;
};
export declare function ProvisionClusterActivity(args: ProvisionClusterArgs): Promise<ProvisionClusterResult>;
//# sourceMappingURL=ProvisionClusterActivity.d.ts.map