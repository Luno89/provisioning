import { execSync } from 'child_process';

// Use tsx/cjs to enable moduleResolution hook and then run tests
execSync('npx tsx -e "Promise.resolve(import(\'./tests/e2e.spec.ts\'))"', { stdio: 'inherit', cwd: '/home/luno/Code/provisioning', timeout: 120000 });
