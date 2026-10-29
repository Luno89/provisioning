import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PINS = fileURLToPath(new URL('../dependencies.pins.json', import.meta.url));

export const ciTools = (pins) => pins.components.filter((component) => component.ciTool);

export function ciToolLine(pins, name) {
  const tool = ciTools(pins).find((component) => component.name === name);
  return tool ? [tool.version, tool.sha256, tool.source, tool.fetch].join('|') : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pins = JSON.parse(readFileSync(PINS, 'utf8'));
  const name = process.argv[2];
  if (name === '--names') {
    console.log(ciTools(pins).map((tool) => tool.name).join(' '));
  } else {
    const line = name ? ciToolLine(pins, name) : undefined;
    if (!line) process.exit(1);
    console.log(line);
  }
}
