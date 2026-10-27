import { describe, expect, it } from 'vitest';
import { cacheFolderProblem, resolveTabbyCacheHostPath, resolveVllmCacheHostPath } from './tabby-cache-path.js';

describe('where a model server keeps its downloads on the node', () => {
  it('is a folder under the cluster\'s own cache folder, the default one when none is named', () => {
    expect(resolveTabbyCacheHostPath()).toBe('/var/lib/rancher/tabbyapi-model-cache');
    expect(resolveVllmCacheHostPath('qwen-cache')).toBe('/var/lib/rancher/qwen-cache');
  });

  it('is never the node\'s root or any path of its own, which would mount the host into the pod', () => {
    for (const asked of ['/', '/etc', '/var/lib/rancher/../../etc', '..', 'a/b', '../etc']) {
      expect(cacheFolderProblem(asked), asked).toMatch(/folder name/);
      expect(() => resolveVllmCacheHostPath(asked), asked).toThrow(/folder name/);
    }
  });
});
