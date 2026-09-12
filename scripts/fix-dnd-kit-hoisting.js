#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['@dnd-kit/utilities', '@dnd-kit/accessibility', 'monaco-editor', '@monaco-editor/loader', 'use-sync-external-store'];

for (const pkg of PACKAGES) {
  const from = path.join(ROOT, 'node_modules', pkg);
  const to = path.join(ROOT, 'apps/frontend/node_modules', pkg);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  console.log(`[fix-dnd-kit-hoisting] moved ${pkg} into apps/frontend/node_modules`);
}
