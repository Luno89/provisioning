import { Construct } from "constructs";
import { VpnConfig } from "../lib/vpn-service.js";
export interface OdooNativeConfig extends VpnConfig {
    readonly namespace?: string;
    readonly odooRepo?: string;
    readonly odooTag?: string;
    readonly pgRepo?: string;
    readonly pgTag?: string;
    readonly dbStorage?: string;
    readonly enabledModules?: string;
    readonly gitRepoPath?: string;
}
export declare class OdooNativeApp extends Construct {
    constructor(scope: Construct, id: string, config?: OdooNativeConfig);
}
//# sourceMappingURL=odoo-native.d.ts.map