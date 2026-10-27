const CACHE_ROOT = '/var/lib/rancher';
const FOLDER = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export const cacheFolderProblem = (folder: unknown): string | undefined =>
  folder === undefined || folder === '' || (typeof folder === 'string' && FOLDER.test(folder) && !folder.includes('..'))
    ? undefined
    : 'a model cache is a folder name of letters, digits, dots, dashes and underscores, kept under the cluster\'s own cache folder';

const hostPath = (folder: string | undefined, fallback: string): string => {
  if (!folder) return `${CACHE_ROOT}/${fallback}`;
  const problem = cacheFolderProblem(folder);
  if (problem) throw new Error(problem);
  return `${CACHE_ROOT}/${folder}`;
};

export const resolveTabbyCacheHostPath = (cachePvc?: string): string => hostPath(cachePvc, 'tabbyapi-model-cache');

export const resolveVllmCacheHostPath = (cachePvc?: string): string => hostPath(cachePvc, 'vllm-model-cache');
