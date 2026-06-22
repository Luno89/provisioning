export interface ClusterMetadata {
  id: string;
  name: string;
  provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
  status: 'provisioning' | 'healthy' | 'failed' | 'destroying';
  kubeconfigPath?: string;
  lastLogPath?: string;
}

export interface DeploymentMetadata {
  id: string;
  name: string;
  clusterId: string;
  strategy: 'helm' | 'native';
  status: 'deploying' | 'running' | 'failed' | 'destroying';
  url?: string;
  lastLogPath?: string;
  modules?: string[]; // IDs of enabled custom modules
}
