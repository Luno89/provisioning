import { Construct } from "constructs";
export interface WordPressConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly dbRepo?: string;
    readonly dbTag?: string;
    readonly dbStorage?: string;
    readonly webStorage?: string;
    readonly serviceType?: string;
}
export declare class WordPressApp extends Construct {
    constructor(scope: Construct, id: string, config?: WordPressConfig);
}
//# sourceMappingURL=wordpress.d.ts.map