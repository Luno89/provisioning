import { Construct } from "constructs";
export interface VpnConfig {
    vpnEnabled?: boolean;
    vpnProtocol?: 'wireguard' | 'openvpn';
    vpnConfig?: string;
    vpnDedicatedIp?: string;
}
export declare class VpnService {
    static apply(scope: Construct, namespace: string, podSpec: any, // This is the pod template spec (spec.template.spec)
    config: VpnConfig): void;
}
//# sourceMappingURL=vpn-service.d.ts.map