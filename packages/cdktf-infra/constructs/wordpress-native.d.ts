import { Construct } from "constructs";
import { VpnConfig } from "../lib/vpn-service.js";
export interface WordPressNativeConfig extends VpnConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly dbRepo?: string;
    readonly dbTag?: string;
    readonly dbStorage?: string;
}
export declare class WordPressNativeApp extends Construct {
    constructor(scope: Construct, id: string, config?: WordPressNativeConfig);
}
//# sourceMappingURL=wordpress-native.d.ts.map