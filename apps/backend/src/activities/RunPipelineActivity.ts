import { assessWorkload } from '../infrastructure/index.js';
import fs from 'fs/promises';
import path from 'path';
import { ApplicationFailure } from '@temporalio/common';
import { buildPlanAt, isCommitSha, buildArgEntries } from '../releases/index.js';
import type { Followed } from '../platform/index.js';
import { forPushing, kanikoRegistryArgs, dockerConfigJson } from '../instances/index.js';
import { ignore } from '@koala/engine-core/failures';
import { messageOf, waitingOn } from './failure-reasons.js';
import type { ClusterSteps } from './cluster-steps.js';

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


const BUILD_NAMESPACE = 'pipeline-builds';

async function log(logFile: string, line: string): Promise<void> {
  await fs.appendFile(logFile, `${line}\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
}

export function yamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function workspacePath(sub: string | undefined): string {
  return sub ? path.posix.join('/workspace', sub) : '/workspace';
}

export async function RunPipelineActivity(args: RunPipelineArgs, steps: ClusterSteps): Promise<RunPipelineResult> {
  const koala = steps.access.own();
  const kubectl = (argv: string[]) => steps.access.kubectl(koala, argv);
  const { gitea } = steps;

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

  let podName: string | undefined;
  let logTail: Followed | undefined;

  try {
    await steps.access.apply(koala, manifest);
    await log(args.logFile, `Applied Job ${jobName} in namespace ${BUILD_NAMESPACE}`);

    const waiting = waitingOn(`the build job ${jobName}`);
    for (let i = 0; i < 30 && !podName; i++) {
      const out = await kubectl(['get', 'pods', '-n', BUILD_NAMESPACE, '-l', `job-name=${jobName}`, '-o', 'jsonpath={.items[0].metadata.name}']).catch((err: unknown) => { waiting(err); return ''; });
      if (out && out.trim()) podName = out.trim();
      else await new Promise(r => setTimeout(r, 2000));
    }

    if (podName) {
      logTail = await steps.access.follow(koala, ['logs', '-f', podName, '-n', BUILD_NAMESPACE, '--all-containers=true'], (chunk) => {
        void fs.appendFile(args.logFile, chunk).catch(ignore('the log only shows progress, and the work goes on without it'));
      });
    }

    for (;;) {
      const counts = await kubectl(['get', 'job', jobName, '-n', BUILD_NAMESPACE, '-o', 'jsonpath={.status.succeeded}|{.status.failed}']);
      const [succeeded, failed] = counts.split('|').map((value) => Number(value) || 0);
      if (succeeded) break;
      if (failed) throw new Error('Pipeline build failed — see log for details');
      const pods = await kubectl(['get', 'pods', '-l', `job-name=${jobName}`, '-n', BUILD_NAMESPACE, '-o', 'json']).catch((err: unknown) => { waiting(err); return ''; });
      const health = pods ? assessWorkload(JSON.parse(pods)) : undefined;
      if (health?.health === 'unhealthy') throw new Error(`Pipeline build cannot run: ${health.reason}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    await log(args.logFile, `Build succeeded: ${imageTag}`);
    return { status: 'succeeded', imageTag };
  } finally {
    logTail?.stop();
    await gitea.revokeToken(deployToken.name).catch(async (err: Error) => {
      console.error(`[pipeline] the build's Gitea token ${deployToken.name} could not be revoked: ${err.message}`);
      await log(args.logFile, `The build's Gitea token ${deployToken.name} could not be revoked (${err.message}); revoke it in Gitea`);
    });
    await kubectl(['delete', 'job', jobName, '-n', BUILD_NAMESPACE, '--ignore-not-found']).catch((err: unknown) => {
      console.warn(`[pipeline] the build job ${jobName} in ${BUILD_NAMESPACE} could not be removed: ${messageOf(err)}`);
    });
    await kubectl(['delete', 'secret', gitSecretName, registrySecretName, '-n', BUILD_NAMESPACE, '--ignore-not-found']).catch((err: unknown) => {
      console.warn(`[pipeline] the build's secrets ${gitSecretName} and ${registrySecretName} in ${BUILD_NAMESPACE} could not be removed: ${messageOf(err)}`);
    });
  }
}
