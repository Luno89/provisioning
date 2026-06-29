import { Construct } from "constructs";
import { VpnConfig } from "../lib/vpn-service.js";
export interface NextcloudNativeConfig extends VpnConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly dbRepo?: string;
    readonly dbTag?: string;
    readonly dbStorage?: string;
}
export declare class NextcloudNativeApp extends Construct {
    constructor(scope: Construct, id: string, config?: NextcloudNativeConfig);
}
//# sourceMappingURL=nextcloud-native.d.ts.map