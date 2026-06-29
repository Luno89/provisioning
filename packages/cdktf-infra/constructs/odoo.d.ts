import { Construct } from "constructs";
export interface OdooConfig {
    readonly namespace?: string;
    readonly odooRepo?: string;
    readonly odooTag?: string;
    readonly pgRepo?: string;
    readonly pgTag?: string;
    readonly dbStorage?: string;
    readonly webStorage?: string;
    readonly serviceType?: string;
}
export declare class OdooApp extends Construct {
    constructor(scope: Construct, id: string, config?: OdooConfig);
}
//# sourceMappingURL=odoo.d.ts.map