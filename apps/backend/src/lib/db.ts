import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ClusterMetadata, DeploymentMetadata } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../../data');

export class LocalDB {
  private clustersPath = path.join(DATA_DIR, 'clusters.json');
  private deploymentsPath = path.join(DATA_DIR, 'deployments.json');

  async init() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!(await this.exists(this.clustersPath))) await fs.writeFile(this.clustersPath, '[]');
    if (!(await this.exists(this.deploymentsPath))) await fs.writeFile(this.deploymentsPath, '[]');
  }

  private async exists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    const data = await fs.readFile(this.clustersPath, 'utf-8');
    return JSON.parse(data);
  }

  async saveCluster(cluster: ClusterMetadata) {
    const clusters = await this.getClusters();
    const index = clusters.findIndex(c => c.id === cluster.id);
    if (index >= 0) clusters[index] = cluster;
    else clusters.push(cluster);
    await fs.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
  }

  async saveClusterList(clusters: ClusterMetadata[]) {
    await fs.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    const data = await fs.readFile(this.deploymentsPath, 'utf-8');
    return JSON.parse(data);
  }

  async saveDeployment(deployment: DeploymentMetadata) {
    const deployments = await this.getDeployments();
    const index = deployments.findIndex(d => d.id === deployment.id);
    if (index >= 0) deployments[index] = deployment;
    else deployments.push(deployment);
    await fs.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
  }

  async saveDeploymentList(deployments: DeploymentMetadata[]) {
    await fs.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
  }
}
