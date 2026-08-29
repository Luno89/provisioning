import type { BindingTypeRecord, Database } from './db-interface.js';

export const BINDING_TYPE_SEEDS: BindingTypeRecord[] = [
  {
    id: 'mongodb',
    appType: 'mongo',
    label: 'MongoDB',
    protocol: 'tcp',
    defaultPort: 27017,
    description: 'Document database storage',
    requiredKeys: ['host', 'port', 'username', 'password'],
  },
  {
    id: 's3',
    appType: 'minio',
    label: 'Object Storage (S3 / MinIO)',
    protocol: 'http',
    defaultPort: 9000,
    description: 'S3-compatible object and artifact storage',
    requiredKeys: ['host', 'port', 'rootUser', 'rootPassword'],
  },
  {
    id: 'qdrant',
    appType: 'qdrant',
    label: 'Qdrant Vector Database',
    protocol: 'http',
    defaultPort: 6333,
    description: 'Vector similarity search engine for dense embeddings',
    requiredKeys: ['host', 'port'],
  },
  {
    id: 'quickwit',
    appType: 'quickwit',
    label: 'Quickwit Search Index',
    protocol: 'http',
    defaultPort: 7280,
    description: 'Distributed BM25 tokenized search index',
    requiredKeys: ['host', 'port'],
  },
  {
    id: 'embeddings',
    appType: 'tei',
    label: 'Text Embeddings Inference (TEI)',
    protocol: 'http',
    defaultPort: 80,
    description: 'Dense vector text embeddings inference service',
    requiredKeys: ['host', 'port'],
  },
  {
    id: 'npm',
    appType: 'verdaccio',
    label: 'Verdaccio NPM Registry',
    protocol: 'http',
    defaultPort: 4873,
    description: 'In-cluster private package registry mirror',
    requiredKeys: ['host', 'port'],
  },
  {
    id: 'git',
    appType: 'gitea',
    label: 'Git Forge (Gitea)',
    protocol: 'http',
    defaultPort: 3000,
    description: 'In-cluster Git repository forge and API',
    requiredKeys: ['host', 'port', 'protocol', 'token'],
  },
  {
    id: 'mcp',
    appType: 'gitapp',
    label: 'Model Context Protocol (MCP)',
    protocol: 'http',
    defaultPort: 8080,
    description: 'In-cluster Model Context Protocol tool service over HTTP/SSE',
    requiredKeys: ['host', 'port'],
  },
  {
    id: 'http',
    appType: 'generic',
    label: 'Generic HTTP REST Service',
    protocol: 'http',
    defaultPort: 8080,
    description: 'Generic internal HTTP / REST service',
    requiredKeys: ['host', 'port'],
  },
];

export async function seedBindingTypes(
  db: Pick<Database, 'getBindingTypes' | 'saveBindingType'>,
): Promise<number> {
  const existing = await db.getBindingTypes().catch(() => []);
  const existingIds = new Set(existing.map((t) => t.id));
  let added = 0;

  for (const seed of BINDING_TYPE_SEEDS) {
    if (!existingIds.has(seed.id)) {
      await db.saveBindingType(seed);
      added++;
    }
  }

  return added;
}
