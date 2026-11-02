import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import { tiers } from "../../tests/tiers/projects.js";

const sourceOverBuilt: Plugin = {
  name: "source-over-built",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
    const ts = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
    return existsSync(ts) ? ts : null;
  },
};

export default defineConfig({
  plugins: [sourceOverBuilt],
  test: { projects: tiers({ include: ["**/*.test.ts"], exclude: [".gen/**", "cdktf.out/**"] }) },
});
