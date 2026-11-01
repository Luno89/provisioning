import { assessWorkload, InfrastructureService } from '../infrastructure/index.js';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { GiteaService } from '../projects/index.js';
import { ApplicationFailure } from '@temporalio/common';
import { buildPlanAt, isCommitSha, buildArgEntries } from '../releases/index.js';
import { loadKeys, writePrivate } from '../platform/index.js';
import { forPushing, kanikoRegistryArgs, dockerConfigJson } from '../instances/index.js';
import { ignore } from '@koala/engine-core/failures';
import { messageOf, waitingOn } from './failure-reasons.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_DIR = path.resolve(__dirname, '../../../../bin');

export interface RunPipelineArgs {
  projectId: string;
  giteaOwner: string;
  giteaRepo: string;
  commitSha: string;
  ref: string; // e.g. "main"
  logFile: string;
  runId?: string;
}

export interface RunPipelineResult {
  status: string;
  imageTag: string;
}


const MGMT_CLUSTER = 'provisioning-lunorica';
const MGMT_CONTEXT = `k3d-${MGMT_CLUSTER}`;
const MGMT_KUBECONFIG = `/tmp/kubeconfig-${MGMT_CLUSTER}`;
const BUILD_NAMESPACE = 'pipeline-builds';

export async function resolveKubeconfig(infra: InfrastructureService): Promise<string> {
  try {
    await fs.access(MGMT_KUBECONFIG);
  } catch {
    const content = await infra.getManagementClusterKubeconfig(MGMT_CLUSTER);
    await writePrivate(MGMT_KUBECONFIG, content);
  }
  return MGMT_KUBECONFIG;
}

async function log(logFile: string, line: string): Promise<void> {
  await fs.appendFile(logFile, `${line}\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
}

export function yamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function workspacePath(sub: string | undefined): string {
  return sub ? path.posix.join('/workspace', sub) : '/workspace';
}

export async function RunPipelineActivity(args: RunPipelineArgs): Promise<RunPipelineResult> {
  const infra = new InfrastructureService();
  const kubeconfig = await resolveKubeconfig(infra);
  const gitea = new GiteaService(infra, loadKeys(process.env).data, kubeconfig);

  if (!isCommitSha(args.commitSha)) throw ApplicationFailure.nonRetryable(`"${args.commitSha}" is not a commit to build`, 'NotACommit');
  const runSlug = (args.runId ?? Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  const jobName = `build-${args.giteaRepo}-${args.commitSha.slice(0, 8)}-${runSlug}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
  const registry = await gitea.getRegistryHosts();
  const imageTag = `${registry.pull}/${args.giteaOwner}/${args.giteaRepo}:${args.commitSha}`;
  const gitSecretName = `${jobName}-git-auth`;
  const registrySecretName = `${jobName}-registry-auth`;

  await log(args.logFile, `Building ${args.giteaOwner}/${args.giteaRepo}@${args.commitSha} -> ${imageTag}`);

  const plan = await buildPlanAt((file) => gitea.getRawFile(args.giteaOwner, args.giteaRepo, file, args.commitSha), args.commitSha);
  if (!plan.build) {
    await log(args.logFile, `Nothing to build: ${plan.reason}.`);
    throw ApplicationFailure.nonRetryable(`Nothing to build: ${plan.reason}.`, 'NoDockerfile');
  }
  for (const note of plan.notes) await log(args.logFile, note);
  const pipeline = { config: plan.config };
  const dockerfilePath = plan.dockerfile;

  const buildArgFlags = buildArgEntries(pipeline.config)
    .map(([key, value]) => `--build-arg=${key}=${yamlDoubleQuoted(value)}`);

  const deployToken = await gitea.createDeployToken();
  const authBasic = Buffer.from(`${gitea.adminUsername}:${deployToken.token}`).toString('base64');
  const registryConfig = dockerConfigJson(registry, { username: gitea.adminUsername, password: deployToken.token });

  const manifest = `
apiVersion: v1
kind: Secret
metadata:
  name: ${gitSecretName}
  namespace: ${BUILD_NAMESPACE}
type: Opaque
stringData:
  GIT_AUTH_BASIC: "${authBasic}"
---
apiVersion: v1
kind: Secret
metadata:
  name: ${registrySecretName}
  namespace: ${BUILD_NAMESPACE}
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: '${registryConfig}'
---
apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ${BUILD_NAMESPACE}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: pipeline-build-sa
      automountServiceAccountToken: false
      initContainers:
        - name: clone
          image: alpine/git:latest
          envFrom:
            - secretRef: { name: ${gitSecretName} }
          command: ["sh", "-c"]
          args:
            - "git -c http.extraHeader=\\"Authorization: Basic ${'$'}{GIT_AUTH_BASIC}\\" clone --branch ${args.ref} --single-branch http://${registry.push}/${args.giteaOwner}/${args.giteaRepo}.git /workspace && git -C /workspace checkout -q ${args.commitSha}"
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - "--context=${yamlDoubleQuoted(workspacePath(pipeline.config?.context))}"
            - "--dockerfile=${yamlDoubleQuoted(workspacePath(dockerfilePath))}"
            - "--destination=${forPushing(imageTag, registry)}"
            - "--insecure"
            - "--insecure-pull"
            - "--skip-tls-verify"${kanikoRegistryArgs(registry).map((arg) => `\n            - "${arg}"`).join('')}${buildArgFlags.length ? '\n' + buildArgFlags.map((f) => `            - "${f}"`).join('\n') : ''}
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: docker-config, mountPath: /kaniko/.docker }
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits: { cpu: "1", memory: "1Gi" }
      volumes:
        - name: workspace
          emptyDir: {}
        - name: docker-config
          secret:
            secretName: ${registrySecretName}
            items:
              - { key: .dockerconfigjson, path: config.json }
`.trim();

  const manifestPath = path.join(os.tmpdir(), `pipeline-job-${jobName}.yaml`);
  await fs.writeFile(manifestPath, manifest, 'utf-8');

  let podName: string | undefined;
  let logTail: ReturnType<typeof spawn> | undefined;

  try {
    await infra.runKubectl(['apply', '-f', manifestPath], kubeconfig);
    await log(args.logFile, `Applied Job ${jobName} in namespace ${BUILD_NAMESPACE}`);

    const waiting = waitingOn(`the build job ${jobName}`);
    for (let i = 0; i < 30 && !podName; i++) {
      const out = await infra.runKubectl(['get', 'pods', '-n', BUILD_NAMESPACE, '-l', `job-name=${jobName}`, '-o', 'jsonpath={.items[0].metadata.name}'], kubeconfig).catch((err: unknown) => { waiting(err); return ''; });
      if (out && out.trim()) podName = out.trim();
      else await new Promise(r => setTimeout(r, 2000));
    }

    if (podName) {
      logTail = spawn(path.join(BIN_DIR, 'kubectl'), ['logs', '-f', podName, '-n', BUILD_NAMESPACE, '--all-containers=true', '--context', MGMT_CONTEXT], {
        env: { ...process.env, KUBECONFIG: kubeconfig },
      });
      logTail.stdout?.on('data', (chunk: Buffer) => { void fs.appendFile(args.logFile, chunk).catch(ignore('the log only shows progress, and the work goes on without it')); });
      logTail.stderr?.on('data', (chunk: Buffer) => { void fs.appendFile(args.logFile, chunk).catch(ignore('the log only shows progress, and the work goes on without it')); });
    }

    for (;;) {
      const counts = await infra.runKubectl(['get', 'job', jobName, '-n', BUILD_NAMESPACE, '-o', 'jsonpath={.status.succeeded}|{.status.failed}'], kubeconfig);
      const [succeeded, failed] = counts.split('|').map((value) => Number(value) || 0);
      if (succeeded) break;
      if (failed) throw new Error('Pipeline build failed — see log for details');
      const pods = await infra.runKubectl(['get', 'pods', '-l', `job-name=${jobName}`, '-n', BUILD_NAMESPACE, '-o', 'json'], kubeconfig).catch((err: unknown) => { waiting(err); return ''; });
      const health = pods ? assessWorkload(JSON.parse(pods)) : undefined;
      if (health?.health === 'unhealthy') throw new Error(`Pipeline build cannot run: ${health.reason}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    await log(args.logFile, `Build succeeded: ${imageTag}`);
    return { status: 'succeeded', imageTag };
  } finally {
    logTail?.kill();
    await gitea.revokeToken(deployToken.name).catch(async (err: Error) => {
      console.error(`[pipeline] the build's Gitea token ${deployToken.name} could not be revoked: ${err.message}`);
      await log(args.logFile, `The build's Gitea token ${deployToken.name} could not be revoked (${err.message}); revoke it in Gitea`);
    });
    await infra.runKubectl(['delete', 'job', jobName, '-n', BUILD_NAMESPACE, '--ignore-not-found'], kubeconfig).catch((err: unknown) => {
      console.warn(`[pipeline] the build job ${jobName} in ${BUILD_NAMESPACE} could not be removed: ${messageOf(err)}`);
    });
    await infra.runKubectl(['delete', 'secret', gitSecretName, registrySecretName, '-n', BUILD_NAMESPACE, '--ignore-not-found'], kubeconfig).catch((err: unknown) => {
      console.warn(`[pipeline] the build's secrets ${gitSecretName} and ${registrySecretName} in ${BUILD_NAMESPACE} could not be removed: ${messageOf(err)}`);
    });
    await fs.rm(manifestPath, { force: true }).catch((err: unknown) => {
      console.warn(`[pipeline] the build's manifest ${manifestPath}, which holds its Gitea token, could not be removed: ${messageOf(err)}`);
    });
  }
}
