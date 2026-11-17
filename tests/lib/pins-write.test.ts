import { describe, expect, it } from 'vitest';
import { pinsWritten } from '../../scripts/pins-write.mjs';

const pins = {
  components: [
    {
      kind: 'chart', name: 'widgets', version: '2.0.0', source: 'https://charts.example.com',
      uses: [{ file: 'a.ts', pattern: "chart: 'widgets', version: '([0-9.]+)'" }],
      sourceUses: [{ file: 'a.ts', pattern: "repo: '([^']+)'" }],
    },
    {
      kind: 'image', name: 'tool', version: 'v1.2', sha256: 'b'.repeat(64),
      uses: [{ file: 'b.yml', pattern: 'image: tool:(v[0-9.]+)@' }],
      shaUses: [{ file: 'b.yml', pattern: 'image: tool:v[0-9.]+@sha256:([0-9a-f]{64})' }],
    },
  ],
};

const files: Record<string, string> = {
  'a.ts': "const a = { chart: 'widgets', version: '1.0.0', repo: 'https://old.example.com' };\nconst b = { chart: 'widgets', version: '1.0.0' };\n",
  'b.yml': `image: tool:v1.1@sha256:${'a'.repeat(64)}\n`,
};

describe('writing every file from the pins file', () => {
  it('puts each component\'s version, checksum and source where every recorded use names them, and nothing else', () => {
    expect(Object.fromEntries(pinsWritten(pins, (file) => files[file]!))).toEqual({
      'a.ts': "const a = { chart: 'widgets', version: '2.0.0', repo: 'https://charts.example.com' };\nconst b = { chart: 'widgets', version: '2.0.0' };\n",
      'b.yml': `image: tool:v1.2@sha256:${'b'.repeat(64)}\n`,
    });
  });

  it('changes no file that already says what the pins file says', () => {
    const once = pinsWritten(pins, (file) => files[file]!);
    expect(pinsWritten(pins, (file) => once.get(file)!).size).toBe(0);
  });

  it('refuses a recorded use its file no longer has, naming it', () => {
    expect(() => pinsWritten(pins, (file) => (file === 'a.ts' ? 'nothing here\n' : files[file]!))).toThrow("widgets: a.ts has nothing matching chart: 'widgets', version: '([0-9.]+)'");
  });
});
