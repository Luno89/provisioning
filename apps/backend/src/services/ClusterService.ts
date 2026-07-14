import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { LocalDB } from '../lib/db.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { v4 as uuidv4 } from 'uuid';
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

export class ClusterService extends BaseService {
  private infra: InfrastructureService;

  constructor(db: LocalDB, infra: InfrastructureService) {
    super(db);
    this.infra = infra;
  }

  hasCloudCredentials(provider: ClusterMetadata['provider']): boolean {
    return hasCloudCredentials(provider);
  }

  isMockCloud(cluster: ClusterMetadata): boolean {
    return cluster.provider !== 'k3d' && !this.hasCloudCredentials(cluster.provider);
  }

  getPhysicalClusterName(cluster: ClusterMetadata): string {
    return this.isMockCloud(cluster) ? `mock-${cluster.provider}-${cluster.name}` : cluster.name;
  }

  private async getRealNameservers(): Promise<string[]> {
    const paths = [
      '/run/systemd/resolve/resolv.conf',
      '/var/run/systemd/resolve/resolv.conf',
      '/etc/resolv.conf'
    ];
    
    const nameservers: string[] = [];
    for (const p of paths) {
      try {
        const content = await fs.readFile(p, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('nameserver ')) {
            const ip = trimmed.substring(11).trim();
            if (ip && !ip.startsWith('127.') && ip !== '::1') {
              nameservers.push(ip);
            }
          }
        }
        if (nameservers.length > 0) {
          return nameservers;
        }
      } catch {
        // Continue to next path
      }
    }
    
    return ['8.8.8.8', '1.1.1.1'];
  }

  async getKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    const isMock = this.isMockCloud(cluster);
    if (cluster.provider === 'k3d' || isMock) {
      const physicalName = this.getPhysicalClusterName(cluster);
      const dynamicPath = `/tmp/kubeconfig-${physicalName}`;
      let exists = false;
      try {
        await fs.access(dynamicPath);
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        try {
          const content = await this.infra.getKubeconfig(physicalName);
          await fs.writeFile(dynamicPath, content, 'utf-8');
        } catch (err: any) {
          this.logger.error(`Failed to dynamically fetch kubeconfig for cluster ${physicalName}: ${err.message}`);
          return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
        }
      }
      return dynamicPath;
    }
    return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
  }

  async getAll(io?: SocketServer) {
    const dbClusters = await this.db.getClusters();
    const activeK3dNames = await this.infra.listLocalClusters();
    
    let changed = false;
    const cleanClusters: ClusterMetadata[] = [];
    
    for (const cluster of dbClusters) {
      const isMock = this.isMockCloud(cluster);
      if (cluster.provider === 'k3d' || isMock) {
        const physicalName = this.getPhysicalClusterName(cluster);
        if (cluster.status === 'provisioning') {
          cleanClusters.push(cluster);
          continue;
        }
        if (cluster.status === 'destroying') {
          continue;
        }
        
        if (activeK3dNames.includes(physicalName)) {
          cleanClusters.push(cluster);
        } else {
          changed = true;
          this.logger.info(`Detected local cluster ${physicalName} deleted outside the system. Syncing...`);
          if (io) {
            io.emit('resource-destroyed', { id: cluster.id, type: 'cluster', name: cluster.name, outOfBand: true });
          }
          
          try {
            const deployments = await this.db.getDeployments();
            const cleanDeployments = deployments.filter(d => d.clusterId !== cluster.id);
            if (deployments.length !== cleanDeployments.length) {
              await this.db.saveDeploymentList(cleanDeployments);
            }
            await fs.rm(`/tmp/kubeconfig-${physicalName}`, { force: true }).catch(() => {});
          } catch (err: any) {
            this.logger.error(`Failed to clean up deployments for deleted cluster ${cluster.name}: ${err.message}`);
          }
        }
      } else {
        cleanClusters.push(cluster);
      }
    }
    
    if (changed) {
      await this.db.saveClusterList(cleanClusters);
    }
    
    return cleanClusters;
  }

  async getById(id: string) {
    const clusters = await this.db.getClusters();
    return clusters.find((c: any) => c.id === id);
  }

  async provision(name: string, provider: ClusterMetadata['provider'], io?: SocketServer) {
    const id = uuidv4();
    const logFile = this.infra.getLogPath(name);
    const metadata: ClusterMetadata = { id, name, provider, status: 'provisioning', lastLogPath: logFile };
    await this.db.saveCluster(metadata);

    // Run provisioning in background
    (async () => {
      try {
        let kubeconfigPath = DEFAULT_KUBECONFIG;
        const isMock = this.isMockCloud(metadata);
        const physicalName = this.getPhysicalClusterName(metadata);

        if (provider === 'k3d' || isMock) {
          if (isMock && io) {
            io.to(id).emit('log', `\n--- RUNNING IN MOCK CLOUD MODE (${provider.toUpperCase()}) ---\n`);
            io.to(id).emit('log', `No credentials found for ${provider.toUpperCase()}. Falling back to local k3d cluster "${physicalName}".\n\n`);
          }

          // 1. Ensure kubeconfig context is clean for this name
          try {
            await this.infra.runKubectl(['config', 'unset', 'clusters.k3d-' + physicalName]);
          } catch {
            // Ignore if it doesn't exist
          }

          // 2. Create the physical k3d cluster
          await this.infra.createLocalCluster(physicalName, { logFile, io, resourceId: id });

          // 3. Dynamically fetch kubeconfig from k3d and write to dedicated local file
          const kubeconfigContent = await this.infra.getKubeconfig(physicalName);
          kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;
          await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');

          // 4. Wait for cluster API server and nodes to become responsive and ready
          let ready = false;
          for (let i = 0; i < 45; i++) {
            try {
              const nodesJson = await this.infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
              const nodesObj = JSON.parse(nodesJson);
              const nodes = nodesObj.items || [];
              const hasReadyNode = nodes.some((node: any) =>
                node.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
              );
              if (hasReadyNode) {
                ready = true;
                break;
              }
            } catch (err: any) {
              this.logger.info(`Waiting for cluster ${physicalName} API server: ${err.message}`);
            }

            // Check docker logs for file descriptor limit exhaustion inside the Colima/Docker VM
            if (i > 0 && i % 5 === 0) {
              try {
                const containerName = `k3d-${physicalName}-server-0`;
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                const { stdout, stderr } = await execAsync(`docker logs --tail 200 ${containerName}`);
                const logs = stdout + '\n' + stderr;
                if (logs.includes('too many open files') || logs.includes('fsnotify')) {
                  throw new Error(`Docker/Colima VM resource limit exhausted: 'too many open files' in K3s file watcher. Please run 'colima restart' in your terminal to reset the VM limits.`);
                }
              } catch (logErr: any) {
                if (logErr.message.includes('VM resource limit')) {
                  throw logErr;
                }
              }
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          if (!ready) {
            throw new Error(`Cluster ${physicalName} did not get a Ready control plane node in time.`);
          }

          // Enable volume expansion on default local-path storage class with retries
          try {
            this.logger.info(`Enabling volume expansion on local-path storage class...`);
            let scPatched = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              try {
                await this.infra.runKubectl(['patch', 'storageclass', 'local-path', '-p', '\'{"allowVolumeExpansion": true}\''], kubeconfigPath);
                this.logger.info(`Successfully enabled volume expansion on local-path storage class`);
                scPatched = true;
                break;
              } catch (err: any) {
                this.logger.info(`Waiting for local-path storage class to be available: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            if (!scPatched) {
              this.logger.error(`local-path StorageClass was not available or could not be patched.`);
            }
          } catch (err: any) {
            this.logger.error(`Failed to patch local-path storage class: ${err.message}`);
          }

          // Patch CoreDNS ConfigMap to resolve systemd-resolved loop in hostnetwork mode
          try {
            const dnsList = await this.getRealNameservers();
            this.logger.info(`Patching coredns ConfigMap with nameservers: ${dnsList.join(', ')}`);
            
            let patched = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              try {
                const configMapJson = await this.infra.runKubectl(
                  ['get', 'configmap', 'coredns', '-n', 'kube-system', '-o', 'json'],
                  kubeconfigPath
                );
                const cm = JSON.parse(configMapJson);
                if (cm?.data?.Corefile) {
                  const originalCorefile = cm.data.Corefile;
                  const updatedCorefile = originalCorefile.replace(
                    /forward\s+\.\s+\/etc\/resolv\.conf/g,
                    `forward . ${dnsList.join(' ')}`
                  );
                  if (updatedCorefile !== originalCorefile) {
                    cm.data.Corefile = updatedCorefile;
                    const execAsync = (await import('util')).promisify((await import('child_process')).exec);
                    const containerName = `k3d-${physicalName}-server-0`;
                    const cmJsonString = JSON.stringify(cm).replace(/'/g, "'\\''");
                    await execAsync(`echo '${cmJsonString}' | docker exec -i ${containerName} kubectl replace -f -`);
                    this.logger.info(`Successfully patched coredns ConfigMap`);
                    await this.infra.runKubectl(
                      ['rollout', 'restart', 'deployment/coredns', '-n', 'kube-system'],
                      kubeconfigPath
                    );
                  }
                  patched = true;
                  break;
                }
              } catch (err: any) {
                this.logger.info(`Waiting for coredns configmap to be available: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            if (!patched) {
              this.logger.error(`CoreDNS ConfigMap was not available or could not be patched.`);
            }
          } catch (dnsErr: any) {
            this.logger.error(`Failed to patch coredns: ${dnsErr.message}`);
          }

          // Give it an additional short stabilization delay
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          kubeconfigPath = `/tmp/kubeconfig-${name}`;
        }

        const env: Record<string, string> = { 
          STACK_TYPE: 'cluster', 
          ENV: isMock ? 'local' : provider, 
          CLUSTER_NAME: physicalName,
          KUBECONFIG_PATH: kubeconfigPath
        };

        // 5. Deploy the infrastructure stack (Monitoring, etc.)
        await this.infra.deploy(physicalName, { logFile, io, resourceId: id, env });
        await this.db.saveCluster({ ...metadata, status: 'healthy', kubeconfigPath });
      } catch (err: any) {
        this.logger.error(`Provisioning failed: ${err.message}`);
        await this.db.saveCluster({ ...metadata, status: 'failed' });
      }
    })();

    return metadata;
  }

  async delete(id: string, io?: SocketServer) {
    const cluster = await this.getById(id);
    if (!cluster) throw new Error('Cluster not found');

    const logFile = this.infra.getLogPath(`${cluster.name}-destroy`);
    await this.db.saveCluster({ ...cluster, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        const isMock = this.isMockCloud(cluster);
        const physicalName = this.getPhysicalClusterName(cluster);
        const kubeconfigPath = await this.getKubeconfigPath(cluster);

        // 1. Destroy infrastructure stack
        await this.infra.destroy(physicalName, { 
          logFile, io, resourceId: id, 
          env: { 
            STACK_TYPE: 'cluster', 
            ENV: isMock ? 'local' : cluster.provider, 
            CLUSTER_NAME: physicalName,
            KUBECONFIG_PATH: kubeconfigPath
          }
        });

        // 2. Delete physical k3d cluster if local
        if (cluster.provider === 'k3d' || isMock) {
            await this.infra.deleteLocalCluster(physicalName, { logFile, io, resourceId: id });
            try {
                await fs.rm(kubeconfigPath, { force: true });
            } catch {
                // Ignore
            }
        }

        const clusters = await this.db.getClusters();
        await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));
        if (io) io.emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
      } catch (err: any) {
        this.logger.error(`Destruction failed: ${err.message}`);
        await this.db.saveCluster({ ...cluster, status: 'failed' });
      }
    })();
  }

  async listAllPods(id: string) {
    try {
        const cluster = await this.getById(id);
        if (!cluster) throw new Error('Cluster not found');
        const physicalName = this.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || this.isMockCloud(cluster)) ? `k3d-${physicalName}` : undefined;
        const args = ['get', 'pods', '--all-namespaces', '-o', 'json'];
        if (context) args.push('--context', context);
        
        const kubeconfigPath = await this.getKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(args, kubeconfigPath);
        return JSON.parse(output).items;
    } catch (err: any) {
        this.logger.error(`Failed to list all pods: ${err.message}`);
        return [];
    }
  }

  async listReleases(id: string) {
    try {
        const cluster = await this.getById(id);
        if (!cluster) throw new Error('Cluster not found');
        const physicalName = this.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || this.isMockCloud(cluster)) ? `k3d-${physicalName}` : undefined;
        const args = ['list', '-A', '-o', 'json'];
        if (context) args.push('--kube-context', context);
        
        const kubeconfigPath = await this.getKubeconfigPath(cluster);
        const output = await this.infra.runHelm(args, kubeconfigPath);
        return JSON.parse(output);
    } catch (err: any) {
        this.logger.error(`Failed to list helm releases: ${err.message}`);
        return [];
    }
  }
}
