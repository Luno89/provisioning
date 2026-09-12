import { describe, it, expect } from 'vitest';
import { yamlDoubleQuoted, workspacePath } from './RunPipelineActivity.js';

describe('yamlDoubleQuoted', () => {
  it('leaves an ordinary value untouched', () => {
    expect(yamlDoubleQuoted('production')).toBe('production');
  });

  it('escapes a double quote so it cannot close the YAML string early', () => {
    expect(yamlDoubleQuoted('a"b')).toBe('a\\"b');
  });

  it('escapes a backslash before escaping quotes, so the two do not collide', () => {
    expect(yamlDoubleQuoted('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('workspacePath', () => {
  it('is the bare workspace root with no subpath', () => {
    expect(workspacePath(undefined)).toBe('/workspace');
  });

  it('joins a relative subpath under the workspace root', () => {
    expect(workspacePath('services/api')).toBe('/workspace/services/api');
    expect(workspacePath('docker/Dockerfile')).toBe('/workspace/docker/Dockerfile');
  });
});
