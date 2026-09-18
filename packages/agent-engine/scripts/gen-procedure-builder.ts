import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedBuilderFiles } from '../src/procedure/builder/generated-files.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [path, content] of Object.entries(generatedBuilderFiles())) {
  writeFileSync(resolve(root, path), content);
  console.log(`wrote ${path}`);
}
