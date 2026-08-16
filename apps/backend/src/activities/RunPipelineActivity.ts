/**
 * RunPipelineActivity
 *
 * Builds a sibling project's pushed commit in an isolated, ephemeral Kubernetes Job (Kaniko —
 * no docker.sock, no host access, minimal-RBAC ServiceAccount with zero K8s API permissions,
 * fixed resource limits) and pushes the resulting image to the self-hosted Gitea registry. This
 * is the actual "sandbox" — no docker-in-docker, no shared daemon, nothing the build script can
 * reach beyond network egress to Gitea itself.
 *
 * Manifest shape (git-clone init container -> Kaniko build+push from the cloned workspace) was
 * verified by hand against a real Gitea instance before being encoded here: Kaniko's own
 * `git://` context resolution hardcodes HTTPS with no override, which fails against this
 * platform's plain-HTTP in-cluster Gitea — cloning via an init container into a shared
 * `emptyDir`, then pointing Kaniko at that local directory, sidesteps it entirely.
 */
import fs from 'fs/promises';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { GiteaService } from '../services/GiteaService.js';
import { ApplicationFailure } from '@temporalio/common';

// Same __dirname-relative resolution InfrastructureService itself uses for BIN_DIR (private
// there) — this file lives at the same directory depth (apps/backend/src/activities/ vs
// .../services/), so the relative path to the repo-root bin/ directory is identical.
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
  /**
   * The pipeline run this belongs to, so its Kubernetes Job has a name nothing else shares.
   *
   * Optional only so an older workflow already in flight still deserialises; every caller sets it.
   */
  runId?: string;
}

export interface RunPipelineResult {
  status: string;
  imageTag: string;
}

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { runPipelineActivityMeta } from '../lib/activity-timeouts.js';

const MGMT_CLUSTER = 'provisioning-lunorica';
const MGMT_CONTEXT = `k3d-${MGMT_CLUSTER}`;
const MGMT_KUBECONFIG = `/tmp/kubeconfig-${MGMT_CLUSTER}`;
const BUILD_NAMESPACE = 'pipeline-builds';
const JWT_SECRET = process.env.JWT_SECRET || 'provisioning-platform-secret-12345';

async function resolveKubeconfig(infra: InfrastructureService): Promise<string> {
  try {
    await fs.access(MGMT_KUBECONFIG);
  } catch {
    const content = await infra.getManagementClusterKubeconfig(MGMT_CLUSTER);
    await fs.writeFile(MGMT_KUBECONFIG, content, 'utf-8');
  }
  return MGMT_KUBECONFIG;
}

async function log(logFile: string, line: string): Promise<void> {
  await fs.appendFile(logFile, `${line}\n`).catch(() => {});
}

export async function RunPipelineActivity(args: RunPipelineArgs): Promise<RunPipelineResult> {
  const infra = new InfrastructureService();
  const kubeconfig = await resolveKubeconfig(infra);
  const gitea = new GiteaService(infra, JWT_SECRET, kubeconfig);

  /**
   * Unique per RUN, not per commit.
   *
   * It was `build-<repo>-<commit8>`, and one commit legitimately produces two runs: Gitea posts a
   * webhook for the branch push and another when it lands on main. Both derived the same name, so
   * the second `kubectl apply` hit `spec.template: field is immutable` — a Job's pod template
   * cannot be changed — and then whichever finished first deleted the Job in its cleanup, leaving
   * the other polling a Job that no longer existed: `jobs.batch ... not found`.
   *
   * Measured on koala-request-42784df9: two runs of 62517e2e, both failed, neither for a reason
   * that had anything to do with the code being built.
   */
  const runSlug = (args.runId ?? Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  const jobName = `build-${args.giteaRepo}-${args.commitSha.slice(0, 8)}-${runSlug}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
  const registryHost = await gitea.getRegistryHost();
  const imageTag = `${registryHost}/${args.giteaOwner}/${args.giteaRepo}:${args.commitSha}`;
  const gitSecretName = `${jobName}-git-auth`;
  const registrySecretName = `${jobName}-registry-auth`;

  await log(args.logFile, `Building ${args.giteaOwner}/${args.giteaRepo}@${args.commitSha} -> ${imageTag}`);

  const pipelineFile = await gitea.getRawFile(args.giteaOwner, args.giteaRepo, '.provisioning/pipeline.yml', args.ref).catch(() => null);
  await log(args.logFile, pipelineFile
    ? 'Found .provisioning/pipeline.yml (informational only — build is a fixed Dockerfile+Kaniko build for now)'
    : 'No .provisioning/pipeline.yml — building the repo root Dockerfile');

  /**
   * Refuse before building, and refuse PERMANENTLY.
   *
   * The build is a Dockerfile build, so a repository without one cannot produce an image no matter
   * how many times it is attempted. Temporal's default policy is unlimited, and this had run 622
   * times against one commit — each attempt scheduling a Kubernetes Job, cloning the repo, and
   * watching Kaniko print its usage text because `--dockerfile` resolved to nothing.
   *
   * Checked here rather than inside the Job because the answer is already one API call away, and a
   * failure that says what to do is worth more than a build log that says `error resolving
   * dockerfile path`.
   */
  const dockerfile = await gitea.getRawFile(args.giteaOwner, args.giteaRepo, 'Dockerfile', args.ref).catch(() => null);
  if (!dockerfile) {
    const message = `${args.giteaRepo} has no Dockerfile at its root on ${args.ref}, so there is `
      + 'nothing to build into an image. Add one and push again.';
    await log(args.logFile, message);
    throw ApplicationFailure.nonRetryable(message, 'NoDockerfile');
  }

  const deployToken = await gitea.createDeployToken();
  const authBasic = Buffer.from(`${gitea.adminUsername}:${deployToken.token}`).toString('base64');
  const dockerConfigJson = JSON.stringify({
    auths: { [registryHost]: { auth: Buffer.from(`${gitea.adminUsername}:${deployToken.token}`).toString('base64') } },
  });

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
  .dockerconfigjson: '${dockerConfigJson}'
---
apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ${BUILD_NAMESPACE}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  activeDeadlineSeconds: 1800
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
            - "git -c http.extraHeader=\\"Authorization: Basic ${'$'}{GIT_AUTH_BASIC}\\" clone --branch ${args.ref} --single-branch --depth 1 http://${registryHost}/${args.giteaOwner}/${args.giteaRepo}.git /workspace"
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - "--context=/workspace"
            - "--destination=${imageTag}"
            - "--insecure"
            - "--insecure-pull"
            - "--skip-tls-verify"
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

    // Wait for the pod to exist, then tail its combined output into logFile — activities run in
    // a separate process from the Express/Socket.IO server, so there's no live `io` to push to
    // here; the existing join-room handler in index.ts tails this same file for connected
    // clients, exactly like every other long-running operation in this platform.
    for (let i = 0; i < 30 && !podName; i++) {
      const out = await infra.runKubectl(['get', 'pods', '-n', BUILD_NAMESPACE, '-l', `job-name=${jobName}`, '-o', 'jsonpath={.items[0].metadata.name}'], kubeconfig).catch(() => '');
      if (out && out.trim()) podName = out.trim();
      else await new Promise(r => setTimeout(r, 2000));
    }

    if (podName) {
      logTail = spawn(path.join(BIN_DIR, 'kubectl'), ['logs', '-f', podName, '-n', BUILD_NAMESPACE, '--all-containers=true', '--context', MGMT_CONTEXT], {
        env: { ...process.env, KUBECONFIG: kubeconfig },
      });
      logTail.stdout?.on('data', (chunk) => fs.appendFile(args.logFile, chunk).catch(() => {}));
      logTail.stderr?.on('data', (chunk) => fs.appendFile(args.logFile, chunk).catch(() => {}));
    }

    let status: 'succeeded' | 'failed' | 'timeout' = 'timeout';
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const out = await infra.runKubectl(['get', 'job', jobName, '-n', BUILD_NAMESPACE, '-o', 'json'], kubeconfig);
      const job = JSON.parse(out);
      if ((job.status?.succeeded || 0) > 0) { status = 'succeeded'; break; }
      if ((job.status?.failed || 0) > 0) { status = 'failed'; break; }
      await new Promise(r => setTimeout(r, 5000));
    }

    if (status !== 'succeeded') {
      throw new Error(`Pipeline build ${status === 'timeout' ? 'timed out' : 'failed'} — see log for details`);
    }

    await log(args.logFile, `Build succeeded: ${imageTag}`);
    return { status: 'succeeded', imageTag };
  } finally {
    logTail?.kill();
    await gitea.revokeToken(deployToken.name).catch(() => {});
    await infra.runKubectl(['delete', 'job', jobName, '-n', BUILD_NAMESPACE, '--ignore-not-found'], kubeconfig).catch(() => {});
    await infra.runKubectl(['delete', 'secret', gitSecretName, registrySecretName, '-n', BUILD_NAMESPACE, '--ignore-not-found'], kubeconfig).catch(() => {});
    await fs.rm(manifestPath, { force: true }).catch(() => {});
  }
}
