/**
 * Proves a sandbox can reach what its project declared — and cannot reach what it did not.
 *
 *   npx tsx apps/backend/src/scripts/verify-sandbox-bindings.ts
 *
 * ── WHY THIS SCRIPT AND NOT A UNIT TEST ──
 * The unit tests prove the manifests are right. They cannot prove that a NetworkPolicy written from
 * a resolved binding actually lets a packet through, and that is the entire claim. Two projects
 * burned ~3.7M tokens on leaves that had the correct address and were refused by the network.
 *
 * The control matters as much as the test: a sandbox with no declared dependency must still be
 * unable to reach the service. If it can, the policy is open and every guarantee here is decoration.
 *
 * Creates two throwaway sandboxes and destroys them. Writes nothing else.
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { randomUUID } from 'crypto';
import { createDatabase } from '../lib/db-interface.js';
import { resolveBindings } from '../lib/binding-resolve.js';
import { egressForBindings } from '../lib/workspace-spec.js';
import { WorkspaceService } from '../services/WorkspaceService.js';

const line = () => console.log('─'.repeat(76));

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG);
  const created: string[] = [];

  try {
    const projects = await db.getProjects();
    const project = projects.find((p: any) => (p.needs ?? []).length);
    if (!project) return console.log('No project declares any dependency. Nothing to verify.');

    console.log(`\nProject: ${(project as any).name}`);
    console.log(`Declares: ${JSON.stringify((project as any).needs)}`);

    const { bindings, problems } = resolveBindings(
      (project as any).needs,
      await db.getDeployments(),
      await db.getAppSpecs(),
      (project as any).ownerId,
    );
    for (const p of problems) console.log(`  problem: ${p}`);
    if (!bindings.length) return console.log('Nothing resolved — cannot verify reachability.');

    for (const b of bindings) console.log(`  resolved: ${b.name} -> ${b.host}:${b.port} (secret in ${b.source.namespace})`);

    const egress = egressForBindings(bindings);
    console.log(`  egress:   ${JSON.stringify(egress)}`);

    const files = await workspaces.materializeBindings(bindings);
    for (const f of files) console.log(`  files:    ${f.name}/ -> ${Object.keys(f.files).join(', ')}`);

    // ── THE TEST ──
    line();
    console.log('WITH the declared dependency:');
    const withId = randomUUID();
    await workspaces.create({ leafId: withId, ownerId: (project as any).ownerId, egress, bindings: files });
    created.push(withId);

    const b0 = bindings[0]!;
    const probe = 'set -e; '
      + `echo "SERVICE_BINDING_ROOT=$SERVICE_BINDING_ROOT"; ls "$SERVICE_BINDING_ROOT"; `
      + `H=$(cat "$SERVICE_BINDING_ROOT/${b0.name}/host"); P=$(cat "$SERVICE_BINDING_ROOT/${b0.name}/port"); `
      + 'echo "resolved to $H:$P"; '
      + 'curl -s -o /dev/null -m 8 -w "HTTP=%{http_code} connect=%{time_connect}s\\n" "http://$H:$P/" || echo "CURL FAILED ($?)"';
    const got = await workspaces.exec(withId, probe);
    console.log(got.stdout.trim() || got.stderr.trim());

    // ── THE CONTROL ──
    line();
    console.log('WITHOUT it (same image, no egress, no bindings):');
    const withoutId = randomUUID();
    await workspaces.create({ leafId: withoutId, ownerId: (project as any).ownerId });
    created.push(withoutId);

    const control = `echo "SERVICE_BINDING_ROOT=${'$'}{SERVICE_BINDING_ROOT:-<unset>}"; `
      + `curl -s -o /dev/null -m 8 -w "HTTP=%{http_code}\\n" "http://${b0.host}:${b0.port}/" || echo "REFUSED as expected ($?)"`;
    const denied = await workspaces.exec(withoutId, control);
    console.log(denied.stdout.trim() || denied.stderr.trim());

    line();
    const reached = /HTTP=[1-5]\d\d/.test(got.stdout);
    const blocked = !/HTTP=[1-5]\d\d/.test(denied.stdout);
    console.log(`declared dependency reachable: ${reached ? 'YES' : 'NO'}`);
    console.log(`undeclared service blocked:    ${blocked ? 'YES' : 'NO — THE POLICY IS OPEN'}`);
    console.log(reached && blocked ? '\nBoth hold.' : '\nSomething is wrong — see above.');
  } finally {
    for (const id of created) await workspaces.destroy(id).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
