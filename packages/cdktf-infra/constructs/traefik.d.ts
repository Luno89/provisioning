import { Construct } from "constructs";
export interface TraefikConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly serviceType?: string;
}
export declare class TraefikApp extends Construct {
    constructor(scope: Construct, id: string, config?: TraefikConfig);
}
//# sourceMappingURL=traefik.d.ts.map