import { Construct } from "constructs";
export interface AudiobookshelfConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly metadataStorage?: string;
    readonly configStorage?: string;
    readonly libraryStorage?: string;
    readonly serviceType?: string;
}
export declare class AudiobookshelfApp extends Construct {
    constructor(scope: Construct, id: string, config?: AudiobookshelfConfig);
}
//# sourceMappingURL=audiobookshelf.d.ts.map