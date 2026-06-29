import { Construct } from "constructs";
export interface PrometheusConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly serverStorage?: string;
    readonly serviceType?: string;
}
export declare class PrometheusApp extends Construct {
    constructor(scope: Construct, id: string, config?: PrometheusConfig);
}
//# sourceMappingURL=prometheus.d.ts.map