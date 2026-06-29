import { Construct } from "constructs";
import { VpnConfig } from "../lib/vpn-service.js";
export interface AudiobookshelfNativeConfig extends VpnConfig {
    readonly namespace?: string;
    readonly webRepo?: string;
    readonly webTag?: string;
    readonly metadataStorage?: string;
    readonly configStorage?: string;
    readonly libraryStorage?: string;
}
export declare class AudiobookshelfNativeApp extends Construct {
    constructor(scope: Construct, id: string, config?: AudiobookshelfNativeConfig);
}
//# sourceMappingURL=audiobookshelf-native.d.ts.map