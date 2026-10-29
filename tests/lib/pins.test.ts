import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ciToolLine, ciTools } from '../../scripts/pin.mjs';

interface Use { file: string; pattern: string; arch?: string }
interface Component {
  kind: string;
  name: string;
  version: string;
  sha256?: string;
  sha512?: string;
  sha256s?: Record<string, string>;
  ciTool?: boolean;
  uses?: Use[];
  shaUses?: Use[];
}
interface Pins { components: Component[]; unpinned: { name: string; how: string; usedIn: string[] }[] }

const root = new URL('../../', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');
const pins = JSON.parse(read('dependencies.pins.json')) as Pins;

const found = (use: Use): string[] => [...read(use.file).matchAll(new RegExp(use.pattern, 'gm'))].map((match) => match[1]!);

describe('the pins file', () => {
  it('names every component with a kind, a version and, where it has one, a well-formed checksum', () => {
    for (const component of pins.components) {
      expect(['binary', 'image', 'chart', 'action', 'npm'], component.name).toContain(component.kind);
      expect(component.version, component.name).toMatch(/\S/);
      if (component.sha256) expect(component.sha256, component.name).toMatch(/^[0-9a-f]{64}$/);
      if (component.sha512) expect(component.sha512, component.name).toMatch(/^[0-9a-f]{128}$/);
      for (const [arch, sha] of Object.entries(component.sha256s ?? {})) expect(sha, `${component.name} ${arch}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is what every file that names a component says, so a version changed in one place alone fails here', () => {
    for (const component of pins.components) {
      for (const use of component.uses ?? []) {
        const versions = found(use);
        expect(versions.length, `${component.name} in ${use.file}`).toBeGreaterThan(0);
        expect(new Set(versions), `${component.name} in ${use.file}`).toEqual(new Set([component.version]));
      }
      for (const use of component.shaUses ?? []) {
        const wanted = use.arch ? component.sha256s?.[use.arch] : component.sha256 ?? component.sha512;
        expect(wanted, `${component.name}'s ${use.arch ?? ''} checksum in the pins file`).toBeDefined();
        expect(new Set(found(use)), `${component.name}'s ${use.arch ?? ''} checksum in ${use.file}`).toEqual(new Set([wanted]));
      }
    }
  });

  it('hands ci-tools.sh each tool, which holds no version or checksum of its own', () => {
    const script = read('scripts/ci-tools.sh');
    expect(script).not.toMatch(/[0-9a-f]{64}/);
    expect(script).not.toMatch(/releases\/download\/v[0-9]/);
    for (const tool of ciTools(pins) as Component[]) {
      expect(ciToolLine(pins, tool.name)).toMatch(new RegExp(`^${tool.version.replace(/\./g, '\\.')}\\|${tool.sha256}\\|https://`));
    }
    expect(ciToolLine(pins, 'nothing-by-that-name')).toBeUndefined();
  });

  it('lists what is still installed without a pin, each with where', () => {
    for (const entry of pins.unpinned) {
      expect(entry.usedIn.length, entry.name).toBeGreaterThan(0);
      for (const file of entry.usedIn) expect(() => read(file), `${entry.name} in ${file}`).not.toThrow();
    }
  });
});
