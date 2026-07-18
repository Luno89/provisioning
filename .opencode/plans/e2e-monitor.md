# E2E Monitor Tool — Implementation Plan

## File: `scripts/e2e-monitor.ts`

A single ~350-line TypeScript file, run via `npx tsx scripts/e2e-monitor.ts`.

## Architecture

**Overlay layout (Option B):**
- Dashboard auto-refreshes at top ~16 lines every 2s
- Test output flows below dashboard, scrolls naturally
- Menu on last line of terminal
- Dashboard keeps refreshing even while tests run

## Dashboard Sections (top to bottom)

| Section | Data Source | Format |
|---|---|---|
| Header | Time | `E2E Monitor — HH:MM:SS` |
| MongoDB Clusters | `mongosh` query | `🟢 e2e-fleet-123  healthy    (workflow: cluster-provision-...)` |
| Deployments | `mongosh` query | `🟢 Wordpress-E2E   running    cluster: e2e-fleet-123` |
| Temporal Workflows | `docker exec temporal workflow list` | `RUNNING  cluster-provision-e2e-fleet-123-...` |
| k3d Clusters | `bin/k3d cluster list` | raw output |
| Workers | `ps aux \| grep tsx` | `host ✅ cluster ✅` |
| Logs | `tail -3` of latest log file | last 3 lines |

## Color Coding

- 🟢 healthy/running: green
- 🟡 provisioning: yellow
- 🔴 failed: red
- 🔵 RUNNING workflow: blue
- ⚫ destroyed/terminated: dim
- Headers: cyan, bold
- Data: white/dim

## Menu (last line)

```
Tests: 0 1 2 3 4 5 6 7 8 9 a   Actions: runall terminate cleanup teardown logs quit > _
```

| Key | Action |
|---|---|
| 0-9, a | Run specific Playwright test by `--grep` |
| r | Run all non-skipped tests sequentially |
| t | Terminate running Temporal workflows |
| c | Cleanup MongoDB test collections |
| d | Full teardown (runs `test-e2e-teardown.sh`) |
| l | Show last N log lines |
| q | Quit |

## Test Definitions

Extracted from `tests/e2e.spec.ts`:

```
0  should verify Temporal service health
1  should provision the cluster
2  should deploy and manage Odoo [SKIP]
3  should deploy and manage WordPress
4  should deploy and manage Nextcloud
5  should deploy and manage Audiobookshelf
6  should deploy and manage Prometheus
7  should deploy and manage Traefik
8  should clean up the cluster
9  should clean up UI and DB when cluster is destroyed outside
a  should view, edit, and restore Nginx configuration
```

## Test Execution Flow

1. User presses test key (e.g., `1`)
2. Dashboard stops refreshing input, continues background refresh
3. Spawns: `npx playwright test tests/e2e.spec.ts --grep "should provision the cluster"`
4. stdout/stderr captured, last N lines displayed below dashboard
5. On exit: shows ✅ or ❌, redraws menu
6. Dashboard resumes full refresh

## Key Implementation Details

- **ANSI cursor positioning**: `\x1B[row;colH` for precise placement
- **Clear from cursor**: `\x1B[K` to avoid ghost text
- **Hide cursor**: `\x1B[?25l` during operation, restore on exit
- **readline**: for input, `terminal: false` to get raw lines
- **MongoDB**: uses project's existing `mongodb` driver, connects to `MONGO_TEST_URI`
- **Temporal**: `docker exec provisioning-temporal-1 temporal workflow list --address provisioning-temporal-1:7233`
- **Terminal resize**: `process.stdout.on('resize', ...)` handler

## Dependencies

None new — uses existing `mongodb` from project + Node.js builtins (`child_process`, `readline`, `fs`, `path`).

## Usage

```bash
# Ensure dev stack is running first
npm run dev &

# Start monitor
npx tsx scripts/e2e-monitor.ts
```

## Files to Create

| File | Lines | Purpose |
|---|---|---|
| `scripts/e2e-monitor.ts` | ~350 | Self-contained monitor tool |