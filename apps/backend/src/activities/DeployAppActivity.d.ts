export interface DeployAppArgs {
    name: string;
    clusterId: string;
    clusterName: string;
    provider: string;
    strategy: string;
    appType: string;
    modules?: string[];
    odooRepo: string;
    odooTag: string;
    dbRepo: string;
    dbTag: string;
    logFile: string;
}
export interface DeployAppResult {
    status: string;
    msg: string;
    displayUrl: string;
}
export declare const deployAppActivityMeta: {
    name: string;
    startToCloseTimeout: string;
};
export declare function DeployAppActivity(args: DeployAppArgs): Promise<DeployAppResult>;
//# sourceMappingURL=DeployAppActivity.d.ts.map