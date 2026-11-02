import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DownloadModelActivity } from './DownloadModelActivity.js';

interface Repo { files: Record<string, string>; type?: string }

let repos: Record<string, Repo> = {};
let seen: { url: string; authorization: string | undefined }[] = [];
let server: http.Server;
let origin: string;
let rewrite: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push({ url: `${url.pathname}${url.search}`, authorization: req.headers.authorization });
    const listing = /^\/api\/models\/(.+)\/tree\/([^/]+)$/.exec(url.pathname);
    if (listing) {
      const repo = repos[listing[1]!];
      if (!repo) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Repository not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        ...Object.entries(repo.files).map(([name, body]) => ({ type: 'file', path: name, size: Buffer.byteLength(body) })),
        { type: 'directory', path: 'onnx', size: 0 },
      ]));
      return;
    }
    const file = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
    const body = file ? repos[file[1]!]?.files[file[2]!] : undefined;
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  axios.defaults.proxy = false;
  rewrite = axios.interceptors.request.use((config) => {
    if (config.url?.startsWith('https://huggingface.co')) config.url = `${origin}${config.url.slice('https://huggingface.co'.length)}`;
    return config;
  });
});

afterAll(async () => {
  axios.interceptors.request.eject(rewrite);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let cache: string;

beforeEach(async () => {
  repos = {};
  seen = [];
  cache = await fsp.mkdtemp(path.join(os.tmpdir(), 'koala-model-cache-'));
});

afterEach(async () => {
  await fsp.rm(cache, { recursive: true, force: true });
});

describe('downloading a model from a model host', () => {
  it('lists the repository, downloads every file into the cache folder, writes the marker, and logs its progress to the file it was given', async () => {
    repos['acme/tiny'] = { files: { 'config.json': '{"architectures":["Qwen2ForCausalLM"]}', 'model.safetensors': 'x'.repeat(5000), 'tokenizer/vocab.txt': 'a b c' } };
    const logFile = path.join(cache, 'download.log');

    const result = await DownloadModelActivity({ modelRepo: 'acme/tiny', cacheHostPath: cache, logFile });

    expect(result).toEqual({ skipped: false, totalBytes: 38 + 5000 + 5, modelDir: path.join(cache, 'acme-tiny') });
    expect(await fsp.readFile(path.join(result.modelDir, 'config.json'), 'utf8')).toBe('{"architectures":["Qwen2ForCausalLM"]}');
    expect((await fsp.readFile(path.join(result.modelDir, 'model.safetensors'), 'utf8')).length).toBe(5000);
    expect(await fsp.readFile(path.join(result.modelDir, 'tokenizer', 'vocab.txt'), 'utf8')).toBe('a b c');
    expect(fs.existsSync(`${result.modelDir}.complete`)).toBe(true);
    await vi.waitFor(async () => {
      const lines = (await fsp.readFile(logFile, 'utf8')).split('\n').filter(Boolean);
      expect(lines[0]).toBe('[model-download] Fetching file list for acme/tiny...');
      expect(lines).toContain(`[model-download] 3 files, 0.0 GB total. Downloading to ${result.modelDir}...`);
      expect(lines.some((line) => line.includes('(100%)'))).toBe(true);
      expect(lines.at(-1)).toMatch(/^\[model-download\] (Complete — 0\.0 GB\.|0\.0 \/ 0\.0 GB \(100%\))$/);
    });
  });

  it('asks for the revision it was given, with the token it was given, and skips a model that is already cached', async () => {
    repos['acme/tiny'] = { files: { 'config.json': '{}' } };
    const first = await DownloadModelActivity({ modelRepo: 'acme/tiny', revision: 'v1', hfToken: 'hf_secret', cacheHostPath: cache });

    expect(first.skipped).toBe(false);
    expect(seen.map((request) => request.url)).toEqual(['/api/models/acme/tiny/tree/v1?recursive=true', '/acme/tiny/resolve/v1/config.json']);
    expect(seen.every((request) => request.authorization === 'Bearer hf_secret')).toBe(true);

    seen = [];
    const logFile = path.join(cache, 'again.log');
    const again = await DownloadModelActivity({ modelRepo: 'acme/tiny', revision: 'v1', cacheHostPath: cache, logFile });
    expect(again).toEqual({ skipped: true, totalBytes: 0, modelDir: first.modelDir });
    expect(seen).toEqual([]);
    expect(await fsp.readFile(logFile, 'utf8')).toBe('[model-download] acme/tiny@v1 already cached — skipping download.\n');
  });

  it('starts again from nothing when an earlier download left a folder without its marker', async () => {
    repos['acme/tiny'] = { files: { 'config.json': '{}' } };
    const modelDir = path.join(cache, 'acme-tiny');
    await fsp.mkdir(modelDir, { recursive: true });
    await fsp.writeFile(path.join(modelDir, 'half.bin'), 'partial');

    const result = await DownloadModelActivity({ modelRepo: 'acme/tiny', cacheHostPath: cache });

    expect(result.skipped).toBe(false);
    expect(fs.existsSync(path.join(modelDir, 'half.bin'))).toBe(false);
    expect(fs.existsSync(path.join(modelDir, 'config.json'))).toBe(true);
  });

  it('fails saying so when the repository has no files, and when the host does not know it', async () => {
    repos['acme/empty'] = { files: {} };
    await expect(DownloadModelActivity({ modelRepo: 'acme/empty', cacheHostPath: cache })).rejects.toThrow(/No files found for acme\/empty@main/);
    await expect(DownloadModelActivity({ modelRepo: 'acme/unknown', cacheHostPath: cache })).rejects.toThrow(/404/);
    expect(fs.existsSync(path.join(cache, 'acme-empty.complete'))).toBe(false);
  });

  it('fails and logs it when the download left no config.json, and writes no marker', async () => {
    repos['acme/noconfig'] = { files: { 'other.bin': 'abc' } };
    const logFile = path.join(cache, 'failed.log');

    await expect(DownloadModelActivity({ modelRepo: 'acme/noconfig', cacheHostPath: cache, logFile })).rejects.toThrow(/config\.json is missing/);

    expect(await fsp.readFile(logFile, 'utf8')).toContain('FAILED');
    expect(fs.existsSync(path.join(cache, 'acme-noconfig.complete'))).toBe(false);
  });
});
