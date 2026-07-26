/**
 * Direct HuggingFace Hub API access — file listing and streaming downloads, independent of any
 * downstream tool's own downloader (see DownloadModelActivity.ts for why: TabbyAPI's own
 * `main.py download` swallows failures internally and always exits 0, which silently poisoned a
 * "download complete" cache marker for a directory that was never actually written).
 */
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

/**
 * Backs the wizard's model picker for vLLM/TabbyAPI — replaces a static hardcoded "Popular
 * Models" list of 4-5 entries with live results, sorted by downloads so an empty query still
 * returns something useful (a "trending" list) rather than nothing.
 */
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

/**
 * TabbyAPI's exllamav3 backend only runs EXL3 quants — a generic HF search returns every format
 * (GGUF, AWQ, safetensors, ...) mixed in, most of which TabbyAPI can't load at all. The actual
 * exl3 collection curated by turboderp (exllamav3's own author, and the source of most exl3
 * quants that exist) is the closest thing to an authoritative "will this even work" list, so
 * TabbyAPI's picker uses this instead of generic search entirely — see the `/api/models/search`
 * route for how the two are switched between by appType.
 */
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

/**
 * EXL2/EXL3 quants are distributed as separate branches of the same repo, one per
 * bits-per-weight target (confirmed live: turboderp/Qwen3.6-27B-exl3 has 6.00bpw, 5.00bpw,
 * 4.00bpw, 3.50bpw, 3.00bpw, 2.50bpw, 2.00bpw, plus "main") — the model picker alone doesn't
 * tell you which quant sizes actually exist for the repo you picked. Sorted with real bpw
 * branches first (highest bits-per-weight — best quality — first), anything else (like "main",
 * which is often just a README pointer with no weights) last.
 */
export async function getHfModelBranches(repo: string, token?: string): Promise<string[]> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await axios.get(`https://huggingface.co/api/models/${repo}/refs`, { headers });
  const names: string[] = (res.data.branches as any[]).map((b) => b.name);
  const bpwOf = (name: string) => {
    const m = name.match(/(\d+(?:\.\d+)?)\s*bpw/i);
    return m ? parseFloat(m[1]) : null;
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

/**
 * Fetches config.json directly (not via the tree listing — this needs the actual parsed
 * content, not just a file size). Multimodal repos nest the language-model architecture fields
 * under `text_config` (confirmed live against turboderp/Qwen3.6-27B-exl3's actual config.json);
 * this flattens that so callers don't have to know which shape they got.
 */
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

/**
 * Estimates GPU VRAM needed for the KV cache at a given context length — separate from (and not
 * folded into) the host-side /dev/shm and memoryLimit sizing in tabbyapi.ts, since VRAM isn't a
 * resource Kubernetes' nvidia device plugin lets you request a specific amount of (you request a
 * GPU *count*, not GiB) — this is informational so a user can judge fit against their own
 * hardware before committing to a 20+ minute deploy, not a hard validation gate.
 *
 * Only `full_attention`-type layers contribute a cache that grows with sequence length — hybrid
 * architectures (confirmed live: Qwen3.6-27B-exl3 is 16 full_attention / 48 linear_attention out
 * of 64 total) use a fixed-size state for their linear-attention layers, roughly constant
 * regardless of context length and small enough to not be worth estimating here. A model with no
 * `layer_types` field is a standard non-hybrid transformer — every layer counts.
 */
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

  // 2x for K and V.
  return 2 * numKvHeads * headDim * bytesPerElement * fullAttentionLayers * maxSeqLen;
}

/**
 * Streams every file in `files` into `destDir`, preserving their relative paths. Throws on the
 * first failed file rather than continuing past it — a partial model directory is as useless as
 * an empty one, and the caller (DownloadModelActivity) needs a real exception to retry on.
 */
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
