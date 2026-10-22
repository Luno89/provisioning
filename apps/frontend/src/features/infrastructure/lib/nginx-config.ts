export function insertServerBlock(config: string, block: string): string {
  if (config.includes('http {')) {
    const lastBrace = config.lastIndexOf('}');
    if (lastBrace !== -1) {
      return config.slice(0, lastBrace) + block + '\n' + config.slice(lastBrace);
    }
  }
  return `${config}\n${block}`;
}
