import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

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
  test: { include: ["**/*.test.ts"], exclude: ["node_modules/**", ".gen/**", "cdktf.out/**"] },
});
