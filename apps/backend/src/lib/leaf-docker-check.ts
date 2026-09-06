import { checkDockerfile, describeDockerfileProblems } from './dockerfile-check.js';
import { buildTrackedFilesScript, parseTrackedFiles } from './leaf-checkout.js';

export interface DockerCheckWorkspace {
  exec(leafId: string, script: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(leafId: string, path: string): Promise<string>;
}

export async function checkLeafDockerfile(workspaces: DockerCheckWorkspace, leafId: string): Promise<string> {
  const dockerfile = await workspaces.readFile(leafId, '/work/repo/Dockerfile').catch(() => '');
  if (!dockerfile.trim()) return '';

  const listing = await workspaces
    .exec(leafId, buildTrackedFilesScript())
    .then((r) => parseTrackedFiles(r.stdout))
    .catch(() => [] as string[]);
  const ignore = await workspaces.readFile(leafId, '/work/repo/.dockerignore').catch(() => '');

  let hasDependencies: boolean | undefined;
  const manifest = await workspaces.readFile(leafId, '/work/repo/package.json').catch(() => '');
  if (manifest.trim()) {
    try {
      const parsed = JSON.parse(manifest) as { dependencies?: object; devDependencies?: object };
      hasDependencies = Object.keys(parsed.dependencies ?? {}).length > 0
        || Object.keys(parsed.devDependencies ?? {}).length > 0;
    } catch {
      hasDependencies = undefined;
    }
  }

  const dockerProblems = describeDockerfileProblems(
    checkDockerfile(dockerfile, listing, ignore || undefined, hasDependencies),
  );
  if (dockerProblems) {
    console.warn(`[leaf-docker-check] leaf ${leafId}: ${dockerProblems.replace(/\n/g, ' ')}`);
  }
  return dockerProblems;
}
