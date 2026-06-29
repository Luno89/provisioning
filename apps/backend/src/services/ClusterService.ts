import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { LocalDB } from '../lib/db.js';
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
    if (cluster.provider === 'k3d') {
      const dynamicPath = `/tmp/kubeconfig-${cluster.name}`;
      let exists = false;
      try {
        await fs.access(dynamicPath);
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        try {
          const content = await this.infra.getKubeconfig(cluster.name);
          await fs.writeFile(dynamicPath, content, 'utf-8');
        } catch (err: any) {
          this.logger.error(`Failed to dynamically fetch kubeconfig for k3d cluster ${cluster.name}: ${err.message}`);
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
      if (cluster.provider === 'k3d') {
        if (cluster.status === 'provisioning') {
          cleanClusters.push(cluster);
          continue;
        }
        
        if (activeK3dNames.includes(cluster.name)) {
          cleanClusters.push(cluster);
        } else {
          changed = true;
          this.logger.info(`Detected local k3d cluster ${cluster.name} deleted outside the system. Syncing...`);
          if (io) {
            io.emit('resource-destroyed', { id: cluster.id, type: 'cluster', name: cluster.name, outOfBand: true });
          }
          
          try {
            const deployments = await this.db.getDeployments();
            const cleanDeployments = deployments.filter(d => d.clusterId !== cluster.id);
            if (deployments.length !== cleanDeployments.length) {
              await this.db.saveDeploymentList(cleanDeployments);
            }
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

        if (provider === 'k3d') {
          // 1. Ensure kubeconfig context is clean for this name
          try {
            await this.infra.runKubectl(['config', 'unset', 'clusters.k3d-' + name]);
          } catch {
            // Ignore if it doesn't exist
          }

          // 2. Create the physical k3d cluster
          await this.infra.createLocalCluster(name, { logFile, io, resourceId: id });

          // 3. Dynamically fetch kubeconfig from k3d and write to dedicated local file
          const kubeconfigContent = await this.infra.getKubeconfig(name);
          kubeconfigPath = `/tmp/kubeconfig-${name}`;
          await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');

          // 4. Wait for cluster API server to be responsive both internally and externally
          let ready = false;
          for (let i = 0; i < 30; i++) {
            try {
              // Internal check (inside container)
              await this.infra.runKubectl(['get', 'nodes'], kubeconfigPath);
              // External check (from host)
              await this.infra.runKubectl(['get', 'nodes'], `/tmp/./kubeconfig-${name}`);
              ready = true;
              break;
            } catch (err: any) {
              this.logger.info(`Waiting for cluster ${name} API server: ${err.message}`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
          if (!ready) {
            throw new Error(`Cluster ${name} API server did not become ready in time.`);
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
                    const containerName = `k3d-${name}-server-0`;
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
        }

        const env: Record<string, string> = { 
          STACK_TYPE: 'cluster', 
          ENV: provider, 
          CLUSTER_NAME: name,
          KUBECONFIG_PATH: kubeconfigPath
        };

        // 5. Deploy the infrastructure stack (Monitoring, etc.)
        await this.infra.deploy(name, { logFile, io, resourceId: id, env });
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
    await this.db.saveCluster({ ...cluster, status: 'provisioning', lastLogPath: logFile });

    (async () => {
      try {
        // 1. Destroy infrastructure stack
        await this.infra.destroy(cluster.name, { 
          logFile, io, resourceId: id, 
          env: { STACK_TYPE: 'cluster', ENV: cluster.provider, CLUSTER_NAME: cluster.name }
        });

        // 2. Delete physical k3d cluster if local
        if (cluster.provider === 'k3d') {
            await this.infra.deleteLocalCluster(cluster.name, { logFile, io, resourceId: id });
            try {
                await fs.rm(`/tmp/kubeconfig-${cluster.name}`, { force: true });
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
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
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
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
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
