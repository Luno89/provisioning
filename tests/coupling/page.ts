import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OUT } from './artifacts.js';
import { renderPage } from './render.js';
import type { Result } from './result.js';

const [from = join(OUT, 'result.json'), to = join(OUT, 'report.html')] = process.argv.slice(2).map((path) => resolve(path));
const result = JSON.parse(readFileSync(from, 'utf8')) as Result;
if (result.version !== 1) throw new Error(`${from} is result version ${String(result.version)}; this page renders version 1`);
writeFileSync(to, renderPage(result));
console.log(to);
