import { Construct } from "constructs";
export interface NextcloudConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly dbRepo?: string;
    readonly dbTag?: string;
    readonly dbStorage?: string;
    readonly webStorage?: string;
    readonly serviceType?: string;
}
export declare class NextcloudApp extends Construct {
    constructor(scope: Construct, id: string, config?: NextcloudConfig);
}
//# sourceMappingURL=nextcloud.d.ts.map