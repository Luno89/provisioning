import axios from 'axios';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export interface HfFile {
  path: string;
  size: number;
  url: string;
}

export interface HfModelSearchResult {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
}

export async function searchHfModels(
  query: string,
  options?: { pipelineTag?: string; limit?: number },
): Promise<HfModelSearchResult[]> {
  const params: Record<string, string> = {
    search: query,
    sort: 'downloads',
    direction: '-1',
    limit: String(options?.limit || 20),
  };
  if (options?.pipelineTag) params.filter = options.pipelineTag;
  const res = await axios.get('https://huggingface.co/api/models', { params });
  return (res.data as any[]).map((m) => ({
    id: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    tags: m.tags || [],
  }));
}

export async function getExl3ModelCollection(query?: string): Promise<HfModelSearchResult[]> {
  const res = await axios.get('https://huggingface.co/api/collections/turboderp/exl3-models');
  const items = (res.data.items as any[]).filter((i) => i.repoType === 'model');
  const filtered = query
    ? items.filter((i) => i.id.toLowerCase().includes(query.toLowerCase()))
    : items;
  return filtered
    .map((i) => ({ id: i.id, downloads: i.downloads || 0, likes: i.likes || 0, tags: [] }))
    .sort((a, b) => b.downloads - a.downloads);
}

export async function getHfModelBranches(repo: string, token?: string): Promise<string[]> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get(`https://huggingface.co/api/models/${repo}/refs`, { headers });
  const names: string[] = (res.data.branches as any[]).map((b) => b.name);
  const bpwOf = (name: string) => {
    const m = name.match(/(\d+(?:\.\d+)?)\s*bpw/i);
    return m?.[1] ? parseFloat(m[1]) : null;
  };
  return names.sort((a, b) => {
    const [ba, bb] = [bpwOf(a), bpwOf(b)];
    if (ba !== null && bb !== null) return bb - ba;
    if (ba !== null) return -1;
    if (bb !== null) return 1;
    return a.localeCompare(b);
  });
}

export async function getHfModelFiles(
  repo: string,
  revision: string | undefined,
  token?: string,
): Promise<HfFile[]> {
  const rev = revision || 'main';
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get(
    `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(rev)}?recursive=true`,
    { headers },
  );
  return (res.data as any[])
    .filter((item) => item.type === 'file')
    .map((item) => ({
      path: item.path,
      size: item.size || 0,
      url: `https://huggingface.co/${repo}/resolve/${rev}/${item.path}`,
    }));
}

export async function getHfModelSize(
  repo: string,
  revision: string | undefined,
  token?: string,
): Promise<{ totalBytes: number; fileCount: number }> {
  const files = await getHfModelFiles(repo, revision, token);
  return { totalBytes: files.reduce((sum, f) => sum + f.size, 0), fileCount: files.length };
}

export async function getHfModelConfig(
  repo: string,
  revision: string | undefined,
  token?: string,
): Promise<Record<string, any>> {
  const rev = revision || 'main';
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get(
    `https://huggingface.co/${repo}/raw/${encodeURIComponent(rev)}/config.json`,
    { headers },
  );
  const config = res.data as Record<string, any>;
  return config.text_config ? { ...config, ...config.text_config } : config;
}

const CACHE_MODE_BYTES_PER_ELEMENT: Record<string, number> = {
  FP16: 2, Q8: 1, Q6: 0.75, Q4: 0.5,
};

export function estimateKvCacheBytes(
  config: Record<string, any>,
  maxSeqLen: number,
  cacheMode: string | undefined,
): number {
  const layerTypes: string[] | undefined = config.layer_types;
  const fullAttentionLayers = layerTypes
    ? layerTypes.filter((t) => t === 'full_attention').length
    : (config.num_hidden_layers || 32);

  const headDim = config.head_dim || (config.hidden_size && config.num_attention_heads ? config.hidden_size / config.num_attention_heads : 128);
  const numKvHeads = config.num_key_value_heads || config.num_attention_heads || 8;
  const bytesPerElement = CACHE_MODE_BYTES_PER_ELEMENT[cacheMode || 'FP16'] ?? 2;

  return 2 * numKvHeads * headDim * bytesPerElement * fullAttentionLayers * maxSeqLen;
}

export async function downloadHfFiles(
  files: HfFile[],
  destDir: string,
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  for (const file of files) {
    const dest = path.join(destDir, file.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const response = await axios.get(file.url, { headers, responseType: 'stream' });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(dest);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  }
}
