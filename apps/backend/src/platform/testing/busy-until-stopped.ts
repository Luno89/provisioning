import { writeFileSync } from 'node:fs';

const told = process.argv[2];
if (!told) throw new Error('busy-until-stopped needs the file to write when it is stopped');
process.on('SIGTERM', () => {
  writeFileSync(told, 'stopped on its own terms');
  process.exit(0);
});
setInterval(() => {
  const until = Date.now() + 200;
  while (Date.now() < until);
}, 5);
writeFileSync(`${told}.started`, '');
