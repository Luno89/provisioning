#!/usr/bin/env -S npx tsx
/**
 * E2E Monitor — Interactive dashboard + test runner
 *
 * Usage: npx tsx scripts/e2e-monitor.ts
 *
 * Top portion: auto-refreshing dashboard (every 2s)
 * Bottom: interactive menu
 * Tests run below dashboard, output scrolls naturally
 */
import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

// ── Config ──────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const MONGO_URI = process.env.MONGO_TEST_URI || 'mongodb://admin:admin@localhost:27017/provisioning_test?authSource=admin';
const LOG_DIR = path.join(ROOT, 'apps/backend/data/logs');

// ── ANSI helpers ────────────────────────────────────────────────
const ESC = '\x1B[';
const RESET = '\x1B[0m';
const BOLD = '\x1B[1m';
const DIM = '\x1B[2m';
const RED = '\x1B[31m';
const GREEN = '\x1B[32m';
const YELLOW = '\x1B[33m';
const BLUE = '\x1B[34m';
const MAGENTA = '\x1B[35m';
const CYAN = '\x1B[36m';
const WHITE = '\x1B[37m';
const BG_DARK = '\x1B[40m';
const BG_BLUE = '\x1B[44m';

function moveCursor(row: number, col: number) {
  return `${ESC}${row};${col}H`;
}
function clearFromCursor() {
  return `${ESC}K`;
}
function clearScreen() {
  return `${ESC}2J`;
}

// ── Test definitions ────────────────────────────────────────────
interface TestDef {
  key: string;
  name: string;
  grep: string;
  skipped: boolean;
}

const TESTS: TestDef[] = [
  { key: '0', name: 'verify Temporal health', grep: 'should verify Temporal service health', skipped: false },
  { key: '1', name: 'provision cluster', grep: 'should provision the cluster', skipped: false },
  { key: '2', name: 'deploy Odoo', grep: 'should deploy and manage Odoo', skipped: true },
  { key: '3', name: 'deploy WordPress', grep: 'should deploy and manage WordPress', skipped: false },
  { key: '4', name: 'deploy Nextcloud', grep: 'should deploy and manage Nextcloud', skipped: false },
  { key: '5', name: 'deploy Audiobookshelf', grep: 'should deploy and manage Audiobookshelf', skipped: false },
  { key: '6', name: 'deploy Prometheus', grep: 'should deploy and manage Prometheus', skipped: false },
  { key: '7', name: 'deploy Traefik', grep: 'should deploy and manage Traefik', skipped: false },
  { key: '8', name: 'clean up cluster', grep: 'should clean up the cluster', skipped: false },
  { key: '9', name: 'clean up UI/DB external', grep: 'should clean up UI and DB when cluster is destroyed outside', skipped: false },
  { key: 'a', name: 'view/edit Nginx config', grep: 'should view, edit, and restore Nginx configuration', skipped: false },
];

// ── State ───────────────────────────────────────────────────────
let terminalRows = 24;
let terminalCols = 80;
let testRunning = false;
let dashboardTimer: ReturnType<typeof setInterval> | null = null;
let currentTest: string | null = null;
let lastMongoClusters = '(connecting...)';
let lastDeployments = '(none)';
let lastWorkflows = '(connecting...)';
let lastK3d = '(connecting...)';
let lastWorkers = { host: false, cluster: false };
let lastLogs = '(no logs)';
let lastProgress = '(no active workflow)';
let lastLogTail = '';
let lastK8sPods = '';

// ── Data fetching ───────────────────────────────────────────────
async function getMongoClusters(): Promise<any[]> {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('provisioning_test');
    const clusters = await db.collection('clusters').find({}).sort({ _id: -1 }).limit(10).toArray();
    await client.close();
    return clusters;
  } catch {
    return [];
  }
}

async function getMongoDeployments(): Promise<any[]> {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('provisioning_test');
    const deployments = await db.collection('deployments').find({}).sort({ _id: -1 }).limit(10).toArray();
    await client.close();
    return deployments;
  } catch {
    return [];
  }
}

function getTemporalWorkflows(): string {
  try {
    return execSync(
      'docker exec provisioning-temporal-1 sh -c "temporal workflow list --address provisioning-temporal-1:7233 --limit 10" 2>/dev/null',
      { timeout: 5000 }
    ).toString().trim();
  } catch {
    return '  (unreachable)';
  }
}

function getK3dClusters(): string {
  try {
    const k3d = path.join(ROOT, 'bin/k3d');
    return execSync(`${k3d} cluster list 2>/dev/null`, { timeout: 5000 }).toString().trim();
  } catch {
    return '  (unreachable)';
  }
}

function getWorkerStatus(): { host: boolean; cluster: boolean } {
  try {
    const ps = execSync('ps aux', { timeout: 3000 }).toString();
    return {
      host: ps.includes('worker-host.ts'),
      cluster: ps.includes('worker-cluster.ts'),
    };
  } catch {
    return { host: false, cluster: false };
  }
}

function getRecentLogs(): string {
  try {
    const files = fs.readdirSync(LOG_DIR).sort().reverse();
    for (const f of files.slice(0, 3)) {
      const content = fs.readFileSync(path.join(LOG_DIR, f), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      return lines.slice(-3).map(l => stripAnsi(l).substring(0, 120)).join('\n');
    }
  } catch {}
  return '';
}

function getLogTail(logPath: string): string {
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').map(l => stripAnsi(l)).filter(l => l.trim());
    return lines.slice(-8).join('\n');
  } catch {
    return '(log not found)';
  }
}

function getK8sPods(kubeconfigPath: string): string {
  try {
    const kubectl = path.join(ROOT, 'bin/kubectl');
    const output = execSync(`${kubectl} get pods -A --no-headers --kubeconfig ${kubeconfigPath} 2>/dev/null`, { timeout: 5000 }).toString().trim();
    return output || '  (no pods)';
  } catch {
    return '  (kubeconfig unavailable)';
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

// ── Status helpers ──────────────────────────────────────────────
function statusEmoji(status: string): string {
  switch (status) {
    case 'healthy': return GREEN + '●' + RESET;
    case 'provisioning': return YELLOW + '●' + RESET;
    case 'running': return GREEN + '●' + RESET;
    case 'failed': return RED + '●' + RESET;
    case 'destroyed': return DIM + '●' + RESET;
    default: return YELLOW + '●' + RESET;
  }
}

function wfStatusColor(status: string): string {
  switch (status) {
    case 'Running': return BLUE + 'RUNNING' + RESET;
    case 'Completed': return GREEN + 'COMPLETED' + RESET;
    case 'Failed': return RED + 'FAILED' + RESET;
    case 'Terminated': return DIM + 'TERMINATED' + RESET;
    case 'Cancelled': return YELLOW + 'CANCELLED' + RESET;
    default: return WHITE + status + RESET;
  }
}

function progressStepEmoji(step: string): string {
  const done = ['deploying-cdktf', 'installing-traefik', 'installing-prometheus'];
  if (done.includes(step)) return GREEN + '▶' + RESET;
  return YELLOW + '◌' + RESET;
}

// ── Dashboard rendering ─────────────────────────────────────────
function renderDashboard() {
  const cols = terminalCols;
  const menuRow = terminalRows - 1;

  let output = '';
  let row = 1;

  // Header bar
  output += moveCursor(row, 1) + clearFromCursor();
  output += BG_BLUE + BOLD + WHITE + ` E2E Monitor — ${new Date().toLocaleTimeString()} ` + ' '.repeat(Math.max(0, cols - 32)) + RESET + '\n';
  row++;

  // MongoDB clusters
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + CYAN + ' MongoDB Clusters:' + RESET + '\n';
  row++;
  const clusterLines = lastMongoClusters.split('\n');
  for (const line of clusterLines) {
    output += moveCursor(row, 3) + line + '\n';
    row++;
  }

  // Workflow progress (NEW)
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + YELLOW + ' Progress:' + RESET + '\n';
  row++;
  const progressLines = lastProgress.split('\n');
  for (const line of progressLines) {
    output += moveCursor(row, 3) + line + '\n';
    row++;
  }

  // Live log tail (NEW)
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + MAGENTA + ' Log Tail:' + RESET + '\n';
  row++;
  const logTailLines = lastLogTail.split('\n');
  for (const line of logTailLines.slice(0, 4)) {
    output += moveCursor(row, 3) + DIM + line.substring(0, cols - 5) + RESET + '\n';
    row++;
  }

  // K8s pods (NEW)
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + GREEN + ' K8s Pods:' + RESET + '\n';
  row++;
  const podLines = lastK8sPods.split('\n');
  for (const line of podLines.slice(0, 4)) {
    output += moveCursor(row, 3) + DIM + line.substring(0, cols - 5) + RESET + '\n';
    row++;
  }

  // Temporal workflows
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + BLUE + ' Temporal:' + RESET + '\n';
  row++;
  const wfLines = lastWorkflows.split('\n');
  for (const line of wfLines) {
    output += moveCursor(row, 3) + formatWorkflowLine(line) + '\n';
    row++;
  }

  // k3d clusters
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += BOLD + GREEN + ' k3d:' + RESET + '\n';
  row++;
  const k3dLines = lastK3d.split('\n');
  for (const line of k3dLines) {
    output += moveCursor(row, 3) + DIM + line + RESET + '\n';
    row++;
  }

  // Workers
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  const workers = lastWorkers;
  output += BOLD + ' Workers: ' + RESET;
  output += `host ${workers.host ? GREEN + '●' + RESET : RED + '●' + RESET}  `;
  output += `cluster ${workers.cluster ? GREEN + '●' + RESET : RED + '●' + RESET}`;
  output += '\n';
  row++;

  // Separator
  row++;
  output += moveCursor(row, 1) + clearFromCursor();
  output += DIM + '─'.repeat(cols) + RESET + '\n';
  row++;

  // Test status
  if (currentTest) {
    output += moveCursor(row, 1) + clearFromCursor();
    output += BOLD + YELLOW + ` Running: ${currentTest}` + RESET + '\n';
    row++;
  }

  // Clear remaining lines before menu
  for (let r = row; r < menuRow; r++) {
    output += moveCursor(r, 1) + clearFromCursor();
  }

  // Menu
  output += moveCursor(menuRow, 1) + clearFromCursor();
  output += BG_DARK + BOLD + WHITE + ' Tests: ' + RESET;

  for (const t of TESTS) {
    const color = t.skipped ? DIM : CYAN;
    output += color + `${t.key}` + RESET;
  }

  output += BG_DARK + BOLD + WHITE + '  Actions: ' + RESET;
  output += DIM + 'r' + RESET + 'unall ';
  output += DIM + 't' + RESET + 'erminate ';
  output += DIM + 'c' + RESET + 'leanup ';
  output += DIM + 'd' + RESET + 'teardown ';
  output += DIM + 'l' + RESET + 'ogs ';
  output += DIM + 'q' + RESET + 'uit ';

  const used = output.replace(/[\x1B\[][^m]*m/g, '').length;
  output += ' '.repeat(Math.max(0, cols - used - 3));
  output += '> ';

  process.stdout.write(output);
}

function formatWorkflowLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Status') || trimmed.startsWith('Error')) return trimmed;
  const parts = trimmed.split(/\s{2,}/);
  if (parts.length >= 2) {
    return `${wfStatusColor(parts[0])}  ${DIM + parts.slice(1).join(' ').substring(0, 60) + RESET}`;
  }
  return trimmed;
}

// ── Test execution ──────────────────────────────────────────────
async function runTest(testDef: TestDef) {
  if (testRunning) return;
  testRunning = true;
  currentTest = testDef.name;

  const outputStartRow = terminalRows - 3;

  // Clear test output area
  let clearOutput = '';
  for (let r = outputStartRow; r >= 1; r--) {
    clearOutput += moveCursor(r, 1) + clearFromCursor();
  }
  process.stdout.write(clearOutput);

  // Show test starting
  process.stdout.write(moveCursor(outputStartRow, 1) + clearFromCursor());
  process.stdout.write(BOLD + YELLOW + ` Running: ${testDef.name}` + RESET + '\n');

  // Spawn playwright
  const child = spawn('npx', ['playwright', 'test', 'tests/e2e.spec.ts', '--grep', testDef.grep], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', IS_E2E: 'true', MONGO_TEST_URI: MONGO_URI },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let outputBuffer = '';

  const handleOutput = (data: Buffer) => {
    const text = data.toString();
    outputBuffer += text;

    const availRows = terminalRows - 3;
    const allLines = outputBuffer.split('\n');
    const visibleLines = allLines.slice(-availRows);

    let out = '';
    for (let i = 0; i < visibleLines.length; i++) {
      const r = 1 + i;
      out += moveCursor(r, 1) + clearFromCursor();
      out += visibleLines[i].substring(0, terminalCols - 2) + '\n';
    }
    process.stdout.write(out);
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  const code = await new Promise<number>((resolve) => {
    child.on('close', resolve);
  });

  currentTest = null;
  testRunning = false;

  // Show result
  const resultRow = terminalRows - 2;
  process.stdout.write(moveCursor(resultRow, 1) + clearFromCursor());
  if (code === 0) {
    process.stdout.write(GREEN + BOLD + ` PASS: ${testDef.name}` + RESET + '\n');
  } else {
    process.stdout.write(RED + BOLD + ` FAIL: ${testDef.name} (exit ${code})` + RESET + '\n');
  }

  // Redraw dashboard
  renderDashboard();
  startDashboard();
}

async function runAllTests() {
  const activeTests = TESTS.filter(t => !t.skipped);
  for (const test of activeTests) {
    await runTest(test);
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Actions ─────────────────────────────────────────────────────
async function terminateWorkflow() {
  const workflows = lastWorkflows;
  if (!workflows || workflows.includes('(unreachable)')) {
    process.stdout.write(moveCursor(terminalRows - 2, 1) + clearFromCursor());
    process.stdout.write(RED + 'Temporal unreachable' + RESET + '\n');
    renderDashboard();
    return;
  }

  const lines = workflows.split('\n').filter(l => l.trim().startsWith('Running') || l.trim().startsWith('RUNNING'));
  if (!lines.length) {
    process.stdout.write(moveCursor(terminalRows - 2, 1) + clearFromCursor());
    process.stdout.write(YELLOW + 'No running workflows' + RESET + '\n');
    renderDashboard();
    return;
  }

  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      const wfId = parts[1];
      try {
        execSync(
          `docker exec provisioning-temporal-1 sh -c "temporal workflow terminate --address provisioning-temporal-1:7233 --workflow-id ${wfId}"`,
          { timeout: 10000 }
        );
        process.stdout.write(GREEN + `Terminated: ${wfId}` + RESET + '\n');
      } catch (e: any) {
        process.stdout.write(RED + `Failed: ${wfId}: ${e.message}` + RESET + '\n');
      }
    }
  }
  await refreshData();
}

async function cleanupMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('provisioning_test');
    const c = await db.collection('clusters').deleteMany({});
    const d = await db.collection('deployments').deleteMany({});
    await client.close();
    process.stdout.write(GREEN + `Cleaned: ${c.deletedCount} clusters, ${d.deletedCount} deployments` + RESET + '\n');
    await refreshData();
  } catch (e: any) {
    process.stdout.write(RED + `Cleanup failed: ${e.message}` + RESET + '\n');
  }
}

async function fullTeardown() {
  process.stdout.write(YELLOW + 'Running full teardown...' + RESET + '\n');
  try {
    execSync('bash scripts/test-e2e-teardown.sh', { cwd: ROOT, stdio: 'inherit', timeout: 60000 });
  } catch {}
  await refreshData();
}

function showLogs() {
  const logs = lastLogs;
  const startRow = 1;
  const lines = logs.split('\n');
  let out = '';
  for (let i = 0; i < Math.min(lines.length, terminalRows - 3); i++) {
    out += moveCursor(startRow + i, 1) + clearFromCursor();
    out += lines[i].substring(0, terminalCols - 2) + '\n';
  }
  process.stdout.write(out);
  renderDashboard();
}

// ── Data refresh ────────────────────────────────────────────────
async function refreshData() {
  const [clusters, deployments, workflows, k3d, workers, logs] = await Promise.all([
    getMongoClusters(),
    getMongoDeployments(),
    Promise.resolve(getTemporalWorkflows()),
    Promise.resolve(getK3dClusters()),
    Promise.resolve(getWorkerStatus()),
    Promise.resolve(getRecentLogs()),
  ]);

  // Find active provisioning cluster for detailed view
  const activeCluster = clusters.find(c => c.status === 'provisioning');

  lastMongoClusters = clusters.length
    ? clusters.map(c => {
        let line = `${statusEmoji(c.status)} ${c.name.padEnd(20)} ${c.status.padEnd(14)}`;
        if (c.progress) {
          line += ` ${progressStepEmoji(c.progress.step)} ${c.progress.step}`;
        }
        line += ` ${DIM}${(c.temporalWorkflowId || '').substring(0, 35)}${RESET}`;
        return line;
      }).join('\n')
    : '  (none)';

  lastDeployments = deployments.length
    ? deployments.map(d => `${statusEmoji(d.status)} ${(d.name || d.appName || 'unknown').padEnd(20)} ${d.status.padEnd(12)} cluster: ${(d.clusterName || '?').padEnd(15)}`).join('\n')
    : '(none)';

  lastWorkflows = workflows;
  lastK3d = k3d;
  lastWorkers = workers;
  lastLogs = logs;

  // Progress detail for active cluster
  if (activeCluster?.progress) {
    const p = activeCluster.progress;
    lastProgress = `${progressStepEmoji(p.step)} ${BOLD}${p.step}${RESET} — ${p.message.substring(0, 60)}`;
    lastProgress += `\n${DIM}since ${p.timestamp}${RESET}`;
  } else if (activeCluster) {
    lastProgress = `${YELLOW}●${RESET} ${activeCluster.name} — waiting for progress update...`;
  } else {
    lastProgress = DIM + '(no active workflow)' + RESET;
  }

  // Log tail for active cluster
  if (activeCluster?.lastLogPath) {
    lastLogTail = getLogTail(activeCluster.lastLogPath);
  } else {
    lastLogTail = DIM + '(no log file)' + RESET;
  }

  // K8s pods for active cluster
  if (activeCluster?.kubeconfigPath) {
    lastK8sPods = getK8sPods(activeCluster.kubeconfigPath);
  } else if (activeCluster) {
    const kubeconfigPath = `/tmp/kubeconfig-${activeCluster.name}`;
    if (fs.existsSync(kubeconfigPath)) {
      lastK8sPods = getK8sPods(kubeconfigPath);
    } else {
      lastK8sPods = DIM + '(kubeconfig not ready)' + RESET;
    }
  } else {
    lastK8sPods = DIM + '(no active cluster)' + RESET;
  }

  renderDashboard();
}

// ── Dashboard lifecycle ─────────────────────────────────────────
function startDashboard() {
  if (dashboardTimer) clearInterval(dashboardTimer);
  refreshData();
  dashboardTimer = setInterval(() => {
    if (!testRunning) refreshData();
  }, 2000);
}

function stopDashboard() {
  if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
}

// ── Input handling ──────────────────────────────────────────────
function setupInput() {
  const rl = createInterface({
    input: process.stdin,
    output: null,
    terminal: false,
  });

  process.stdout.write(`${ESC}?25l`);

  rl.on('line', async (line) => {
    const input = line.trim().toLowerCase();

    if (input === 'q') {
      process.stdout.write(`${ESC}?25h\n`);
      stopDashboard();
      process.exit(0);
    }

    if (testRunning) {
      process.stdout.write(moveCursor(terminalRows - 1, 1) + clearFromCursor());
      process.stdout.write(YELLOW + ' Test still running... press q to quit' + RESET + '\n');
      return;
    }

    stopDashboard();

    const testDef = TESTS.find(t => t.key === input);
    if (testDef) {
      if (testDef.skipped) {
        process.stdout.write(moveCursor(terminalRows - 2, 1) + clearFromCursor());
        process.stdout.write(YELLOW + `[SKIP] ${testDef.name}` + RESET + '\n');
        startDashboard();
        return;
      }
      await runTest(testDef);
      return;
    }

    switch (input) {
      case 'r':
        await runAllTests();
        break;
      case 't':
        await terminateWorkflow();
        break;
      case 'c':
        await cleanupMongo();
        break;
      case 'd':
        await fullTeardown();
        break;
      case 'l':
        showLogs();
        startDashboard();
        break;
      default:
        process.stdout.write(moveCursor(terminalRows - 2, 1) + clearFromCursor());
        process.stdout.write(YELLOW + `Unknown: ${input}` + RESET + '\n');
        startDashboard();
    }
  });

  rl.on('close', () => {
    process.stdout.write(`${ESC}?25h\n`);
    stopDashboard();
    process.exit(0);
  });
}

// ── Terminal resize handling ────────────────────────────────────
function handleResize() {
  terminalRows = process.stdout.rows || 24;
  terminalCols = process.stdout.columns || 80;
  renderDashboard();
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  terminalRows = process.stdout.rows || 24;
  terminalCols = process.stdout.columns || 80;

  process.stdout.write(clearScreen() + moveCursor(1, 1));
  process.stdout.on('resize', handleResize);

  process.stdout.write(BOLD + CYAN + ' E2E Monitor — starting...' + RESET + '\n');

  startDashboard();
  setupInput();
}

main().catch((err) => {
  process.stdout.write(`${ESC}?25h`);
  console.error(RED + 'Fatal error:', err + RESET);
  process.exit(1);
});