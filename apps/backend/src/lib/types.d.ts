export interface ClusterMetadata {
    id: string;
    name: string;
    provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
    status: 'provisioning' | 'healthy' | 'failed' | 'destroying';
    kubeconfigPath?: string;
    lastLogPath?: string;
    temporalWorkflowId?: string;
    [key: string]: any;
}
export interface DeploymentMetadata {
    id: string;
    name: string;
    clusterId: string;
    strategy: 'helm' | 'native';
    appType?: 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik';
    status: 'deploying' | 'running' | 'failed' | 'destroying';
    webRepo?: string;
    webTag?: string;
    dbRepo?: string;
    dbTag?: string;
    url?: string;
    isExposed?: boolean;
    exposureUrl?: string;
    lastLogPath?: string;
    modules?: string[];
    storage?: Record<string, string>;
    vpnEnabled?: boolean;
    vpnProtocol?: 'wireguard' | 'openvpn';
    vpnConfig?: string;
    vpnDedicatedIp?: string;
    temporalWorkflowId?: string;
    [key: string]: any;
}
//# sourceMappingURL=types.d.ts.map