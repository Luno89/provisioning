import axios from 'axios';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { Readable } from 'stream';
import { listAt, recordAt, type JsonRecord } from './json-reading.js';

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

const countOf = (value: unknown): number => (typeof value === 'number' && value ? value : 0);

const positive = (value: unknown): number | undefined => (typeof value === 'number' && value ? value : undefined);

function modelFound(raw: unknown, tags: string[]): HfModelSearchResult {
  const m = recordAt(raw);
  return { id: String(m.id), downloads: countOf(m.downloads), likes: countOf(m.likes), tags };
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
  const res = await axios.get<unknown>('https://huggingface.co/api/models', { params });
  return listAt(res.data).map((m) => modelFound(m, listAt(m, 'tags').map(String)));
}

export async function getExl3ModelCollection(query?: string): Promise<HfModelSearchResult[]> {
  const res = await axios.get<unknown>('https://huggingface.co/api/collections/turboderp/exl3-models');
  const items = listAt(res.data, 'items').filter((i) => recordAt(i).repoType === 'model').map((i) => modelFound(i, []));
  const filtered = query
    ? items.filter((i) => i.id.toLowerCase().includes(query.toLowerCase()))
    : items;
  return filtered.sort((a, b) => b.downloads - a.downloads);
}

export async function getHfModelBranches(repo: string, token?: string): Promise<string[]> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get<unknown>(`https://huggingface.co/api/models/${repo}/refs`, { headers });
  const names = listAt(res.data, 'branches').map((b) => String(recordAt(b).name));
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
  const res = await axios.get<unknown>(
    `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(rev)}?recursive=true`,
    { headers },
  );
  return listAt(res.data)
    .map((raw) => recordAt(raw))
    .filter((item) => item.type === 'file')
    .map((item) => ({
      path: String(item.path),
      size: countOf(item.size),
      url: `https://huggingface.co/${repo}/resolve/${rev}/${String(item.path)}`,
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
): Promise<JsonRecord> {
  const rev = revision || 'main';
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get<unknown>(
    `https://huggingface.co/${repo}/raw/${encodeURIComponent(rev)}/config.json`,
    { headers },
  );
  const config = recordAt(res.data);
  return config.text_config ? { ...config, ...recordAt(config.text_config) } : config;
}

const CACHE_MODE_BYTES_PER_ELEMENT: Record<string, number> = {
  FP16: 2, Q8: 1, Q6: 0.75, Q4: 0.5,
};

export function estimateKvCacheBytes(
  config: JsonRecord,
  maxSeqLen: number,
  cacheMode: string | undefined,
): number {
  const fullAttentionLayers = Array.isArray(config.layer_types)
    ? listAt(config, 'layer_types').filter((t) => t === 'full_attention').length
    : (positive(config.num_hidden_layers) ?? 32);

  const hiddenSize = positive(config.hidden_size);
  const attentionHeads = positive(config.num_attention_heads);
  const headDim = positive(config.head_dim) ?? (hiddenSize && attentionHeads ? hiddenSize / attentionHeads : 128);
  const numKvHeads = positive(config.num_key_value_heads) ?? attentionHeads ?? 8;
  const bytesPerElement = CACHE_MODE_BYTES_PER_ELEMENT[cacheMode || 'FP16'] ?? 2;

  return 2 * numKvHeads * headDim * bytesPerElement * fullAttentionLayers * maxSeqLen;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  currentFile: string;
}

export async function downloadHfFiles(
  files: HfFile[],
  destDir: string,
  token?: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let downloadedBytes = 0;
  let lastReportAt = 0;
  for (const file of files) {
    const dest = path.join(destDir, file.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const response = await axios.get<Readable>(file.url, { headers, responseType: 'stream' });
    const body = response.data;
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(dest);
      if (onProgress) {
        body.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastReportAt >= 2000) {
            lastReportAt = now;
            onProgress({ downloadedBytes, totalBytes, currentFile: file.path });
          }
        });
      }
      body.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      body.on('error', reject);
    });
  }
  if (onProgress) onProgress({ downloadedBytes, totalBytes, currentFile: '' });
}
