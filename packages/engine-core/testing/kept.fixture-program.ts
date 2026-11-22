import { startKept } from './kept.js';

const kept = startKept({ command: 'sh', args: ['-c', 'echo "program $$"; exec sleep 600'], env: { PATH: process.env.PATH } }, { heard: { stdout: (chunk) => { process.stdout.write(chunk); } } });
process.stdout.write(`keeper ${kept.pid}\n`);
