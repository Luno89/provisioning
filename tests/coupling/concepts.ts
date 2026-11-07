import type { Edge } from './graph.js';

export interface Concept {
  id: string;
  label: string;
  marks?: readonly RegExp[];
  through?: readonly Edge['through'][];
  inFile?: RegExp;
}

export const CONCEPTS: readonly Concept[] = [
  {
    id: 'kubeconfig',
    label: 'obtains a kubeconfig',
    marks: [/\/tmp\/kubeconfig/, /\.kube\/config/, /k3s\.yaml/, /kubeconfig get/, /config view --minify/, /\bK8S_HOST\b/, /\bKUBECONFIG_PATH\b/, /handed-kubeconfig/, /\bKUBECONFIG:/],
  },
  {
    id: 'cluster-command',
    label: 'uses kubectl, helm or k3d',
    marks: [/['"`/]kubectl\b/, /['"`/]helm\b/, /['"`/]k3d\b/, /docker exec/, /['"`]exec['"`],\s*['"`-]/],
  },
  { id: 'work', label: 'starts or hands work to another process', through: ['temporal'] },
  { id: 'config', label: 'reads configuration', marks: [/\bprocess\.env\b/, /\benv\.[A-Z][A-Z0-9_]{2,}\b/, /\benv\[['"`][A-Z][A-Z0-9_]{2,}['"`]\]/] },
  { id: 'store', label: 'reads or writes stored records', inFile: /(^|\/)store\.ts$/ },
  { id: 'calls-out', label: 'calls a service over the network', marks: [/\bfetch\(/, /\baxios\.(get|post|put|patch|delete|create|request)\b/, /\bpublicFetch\(/] },
  {
    id: 'files',
    label: 'keeps, reads, shares or removes a person\'s files',
    marks: [
      /from ['"]minio['"]/, /\b(putObject|getObject|statObject|removeObjects?|listObjects(V2)?|fPutObject|fGetObject|copyObject|makeBucket|bucketExists|presigned\w*)\(/,
      /koala-files|koala-artifacts|\bARTIFACT_BUCKET\b|\bFILES_BUCKET\b/, /['"`]minio['"`]/i, /\bS3\b|\bs3[A-Z]\w*/,
      /\b(FileService|FileStores|FileStore|ArtifactService|ArtifactStore|StoredArtifact|FileShare|FilePlace|FileScope|MessageAttachment|StoryDrop\w*|RepositoryDrop\w*)\b/,
      /\b(fileSettings|fileShares|artifactChunks|storedFiles)\b/, /['"`]artifacts['"`]/,
      /\b(list_files|read_stored_file|store_file|remove_stored_file)\b/,
      /\/files\/|\/artifacts\b|\/share\//, /\battachments?\b/i,
      /\b(uploadStoredFile|listStoredFiles|moveStoredFile|removeStoredFile|downloadStoredFile|shareStoredFile|storedFileUrl)\b/,
    ],
  },
];

export const conceptNamed = (id: string): Concept => {
  const concept = CONCEPTS.find((entry) => entry.id === id);
  if (!concept) throw new Error(`there is no concept "${id}"; the concepts are ${CONCEPTS.map((entry) => entry.id).join(', ')}`);
  return concept;
};
