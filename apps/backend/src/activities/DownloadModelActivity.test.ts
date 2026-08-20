import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

const getHfModelFiles = vi.fn();
const downloadHfFiles = vi.fn();

vi.mock('../lib/huggingface.js', () => ({
  getHfModelFiles,
  downloadHfFiles,
}));

const { DownloadModelActivity } = await import('./DownloadModelActivity.js');

describe('DownloadModelActivity', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabby-model-cache-test-'));
  });

  it('skips download when .complete marker and config.json exist', async () => {
    const modelDir = path.join(tmpDir, 'testorg-testmodel');
    await fsp.mkdir(modelDir, { recursive: true });
    await fsp.writeFile(path.join(modelDir, 'config.json'), '{"architectures":["Qwen2ForCausalLM"]}');
    await fsp.writeFile(`${modelDir}.complete`, '');

    const result = await DownloadModelActivity({
      modelRepo: 'testorg/testmodel',
      cacheHostPath: tmpDir,
    });

    expect(result.skipped).toBe(true);
    expect(result.totalBytes).toBe(0);
    expect(getHfModelFiles).not.toHaveBeenCalled();
    expect(downloadHfFiles).not.toHaveBeenCalled();
  });

  it('throws when mkdir encounters permission error', async () => {
    const nonWritableDir = '/root/forbidden-cache-dir';

    await expect(
      DownloadModelActivity({
        modelRepo: 'testorg/testmodel',
        cacheHostPath: nonWritableDir,
      }),
    ).rejects.toThrow();
  });

  it('downloads files and writes .complete marker when folder is writable', async () => {
    const files = [
      { rfilename: 'config.json', size: 100 },
      { rfilename: 'model.safetensors', size: 5000 },
    ];
    getHfModelFiles.mockResolvedValue(files);
    downloadHfFiles.mockImplementation(async (_files, dir) => {
      await fsp.writeFile(path.join(dir, 'config.json'), '{}');
      await fsp.writeFile(path.join(dir, 'model.safetensors'), 'dummy');
    });

    const result = await DownloadModelActivity({
      modelRepo: 'testorg/testmodel',
      revision: 'main',
      cacheHostPath: tmpDir,
    });

    expect(result.skipped).toBe(false);
    expect(result.totalBytes).toBe(5100);
    expect(fs.existsSync(path.join(result.modelDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(`${result.modelDir}.complete`)).toBe(true);
  });

  it('throws an error if no files are returned for the repo', async () => {
    getHfModelFiles.mockResolvedValue([]);

    await expect(
      DownloadModelActivity({
        modelRepo: 'testorg/emptyrepo',
        cacheHostPath: tmpDir,
      }),
    ).rejects.toThrow(/No files found/);
  });

  it('throws an error if config.json is missing after download', async () => {
    getHfModelFiles.mockResolvedValue([{ rfilename: 'other.bin', size: 100 }]);
    downloadHfFiles.mockImplementation(async () => {});

    await expect(
      DownloadModelActivity({
        modelRepo: 'testorg/noconfig',
        cacheHostPath: tmpDir,
      }),
    ).rejects.toThrow(/config\.json is missing/);
  });
});
