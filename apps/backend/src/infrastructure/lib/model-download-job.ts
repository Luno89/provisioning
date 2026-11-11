import { createHash } from 'node:crypto';

export const MODEL_DOWNLOADS = 'koala-models';
export const HUGGING_FACE = 'https://huggingface.co';
export const ALREADY_HERE = 'already on this machine';

export const DOWNLOAD_SCRIPT = `
import json, os, shutil, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path
endpoint = os.environ['HF_ENDPOINT'].rstrip('/')
repo = os.environ['REPO']
revision = os.environ.get('REVISION') or 'main'
folder = Path('/cache') / os.environ['FOLDER']
done = Path(str(folder) + '.complete')
token = os.environ.get('HF_TOKEN')
headers = {'Authorization': 'Bearer ' + token} if token else {}
if done.exists() and (folder / 'config.json').exists():
    print('${ALREADY_HERE}', flush=True)
    sys.exit(0)
def get(url):
    try:
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers))
    except urllib.error.HTTPError as err:
        sys.exit(f'Hugging Face answered {err.code} for {url}: check the model name, its revision, and the token for a gated model')
shutil.rmtree(folder, ignore_errors=True)
folder.mkdir(parents=True)
listed = json.load(get(f"{endpoint}/api/models/{repo}/tree/{urllib.parse.quote(revision, safe='')}?recursive=true"))
files = [entry for entry in listed if entry.get('type') == 'file']
if not files:
    sys.exit(f'no files found for {repo}@{revision}: check the model name and revision')
total = sum(entry.get('size') or 0 for entry in files)
print(f'{len(files)} files, {total / 1e9:.1f} GB, into {folder}', flush=True)
for entry in files:
    target = folder / entry['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    with get(f"{endpoint}/{repo}/resolve/{revision}/{entry['path']}") as answer, open(target, 'wb') as out:
        shutil.copyfileobj(answer, out, 1 << 20)
    print(f"fetched {entry['path']}", flush=True)
if not (folder / 'config.json').exists():
    sys.exit(f'config.json is missing after downloading {repo}@{revision}: the repository does not have the layout a model server reads')
done.touch()
print('complete', flush=True)
`;

export const modelJobName = (folder: string): string => `model-${createHash('sha256').update(folder).digest('hex').slice(0, 16)}`;

export interface ModelDownload {
  name: string;
  image: string;
  repo: string;
  revision?: string | undefined;
  folder: string;
  cacheHostPath: string;
  endpoint: string;
  tokenSecret?: string | undefined;
}

export function modelDownloadJob(job: ModelDownload): Record<string, unknown> {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: job.name, namespace: MODEL_DOWNLOADS, labels: { 'app.kubernetes.io/component': 'model-download' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/component': 'model-download' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'download',
            image: job.image,
            command: ['python3', '-c', DOWNLOAD_SCRIPT],
            env: [
              { name: 'HF_ENDPOINT', value: job.endpoint },
              { name: 'REPO', value: job.repo },
              { name: 'REVISION', value: job.revision ?? '' },
              { name: 'FOLDER', value: job.folder },
              ...(job.tokenSecret ? [{ name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name: job.tokenSecret, key: 'HF_TOKEN' } } }] : []),
            ],
            securityContext: { runAsUser: 0 },
            volumeMounts: [{ name: 'cache', mountPath: '/cache' }],
          }],
          volumes: [{ name: 'cache', hostPath: { path: job.cacheHostPath, type: 'DirectoryOrCreate' } }],
        },
      },
    },
  };
}
