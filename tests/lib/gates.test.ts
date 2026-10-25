import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changedBesidesLedger, HOTFIX_STEPS, ignoredRefusal, leaksRefusal, NO_COMMIT, nextVersion, pushedRange, onlyLedger, pushRefusal, RELEASE_SIGNERS, RELEASE_STEPS, SHIP_STEPS, signingKeyProblem, TAG_SIGNATURE, tagMessage, unsignedTagRefusal } from './gates.js';

const shipped = { at: '2026-10-24T01:00:00.000Z', steps: [] };
const released = (version: string) => ({ ...shipped, version, previous: 'v2026.10.23' });

describe('what a push may carry', () => {
  it('lets main take a commit that shipped, or a ledger-only commit on top of one', () => {
    expect(pushRefusal('refs/heads/main', { record: { commit: 'a', shipped }, onlyLedgerSinceParent: false })).toBeUndefined();
    expect(pushRefusal('refs/heads/main', { parent: { commit: 'a', shipped }, onlyLedgerSinceParent: true })).toBeUndefined();
  });

  it('refuses main a commit that never shipped, even on top of one that did', () => {
    expect(pushRefusal('refs/heads/main', { onlyLedgerSinceParent: false })).toMatch(/npm run ship/);
    expect(pushRefusal('refs/heads/main', { parent: { commit: 'a', shipped }, onlyLedgerSinceParent: false })).toMatch(/npm run ship/);
  });

  it('lets a release tag through only for the commit released under that very name', () => {
    expect(pushRefusal('refs/tags/v2026.10.24', { record: { commit: 'a', shipped, released: released('v2026.10.24') }, onlyLedgerSinceParent: false })).toBeUndefined();
    expect(pushRefusal('refs/tags/v2026.10.24', { record: { commit: 'a', shipped }, onlyLedgerSinceParent: false })).toMatch(/npm run release/);
    expect(pushRefusal('refs/tags/v2026.10.24', { record: { commit: 'a', shipped, released: released('v2026.10.25') }, onlyLedgerSinceParent: false })).toMatch(/npm run release/);
  });

  it('refuses anything that carries a file .gitignore lists, naming it', () => {
    expect(ignoredRefusal([])).toBeUndefined();
    expect(ignoredRefusal(['apps/backend/data/.infisical-encryption-key'])).toMatch(/a file \.gitignore lists.*apps\/backend\/data\/\.infisical-encryption-key\. Untrack/);
    const many = Array.from({ length: 12 }, (_, n) => `node_modules/p${n}.js`);
    expect(ignoredRefusal(many)).toMatch(/12 files .*node_modules\/p9\.js and 2 more\./);
  });

  it('scans only what a push adds: since what the remote has, or everything no remote branch has for a new one', () => {
    expect(pushedRange('aaa', 'bbb')).toBe('aaa..bbb');
    expect(pushedRange(NO_COMMIT, 'bbb')).toBe('bbb --not --remotes=origin');
    expect(pushedRange(undefined, 'bbb')).toBe('bbb --not --remotes=origin');
  });

  it('refuses what Gitleaks finds, and says how to let a made-up test value through', () => {
    expect(leaksRefusal(undefined)).toBeUndefined();
    expect(leaksRefusal('Finding: password = "REDACTED"')).toMatch(/Finding: password = "REDACTED"[\s\S]*\.gitleaksignore/);
  });

  it('leaves any other branch to the typecheck', () => {
    expect(pushRefusal('refs/heads/email', { onlyLedgerSinceParent: false })).toBeUndefined();
  });
});

describe('naming a release', () => {
  it('is the day, then the day with a count once the day has one', () => {
    expect(nextVersion('2026-10-24T03:00:00.000Z', ['v2026.10.23'])).toBe('v2026.10.24');
    expect(nextVersion('2026-10-24', ['v2026.10.24'])).toBe('v2026.10.24-2');
    expect(nextVersion('2026-10-24', ['v2026.10.24', 'v2026.10.24-2'])).toBe('v2026.10.24-3');
  });
});

describe('a checkout that has moved', () => {
  it('counts every change but the live ledger, renames by where they went', () => {
    expect(changedBesidesLedger(' M tests/LAST-PASSED.md\n M tests/last-passed.json\n')).toEqual([]);
    expect(changedBesidesLedger(' M tests/LAST-PASSED.md\n?? scratch.txt\nR  a.ts -> b.ts\n')).toEqual(['scratch.txt', 'b.ts']);
  });

  it('knows a commit that changed only the ledger', () => {
    expect(onlyLedger(['tests/LAST-PASSED.md', 'tests/last-passed.json'])).toBe(true);
    expect(onlyLedger(['tests/LAST-PASSED.md', 'CLAUDE.md'])).toBe(false);
    expect(onlyLedger([])).toBe(false);
  });
});

describe('the gates', () => {
  it('run every step through an npm script once, the rehearsal last', () => {
    const scripts = [...SHIP_STEPS, ...RELEASE_STEPS].map((step) => step.script);
    expect(new Set(scripts).size).toBe(scripts.length);
    scripts.push(...HOTFIX_STEPS.map((step) => step.script));
    expect(RELEASE_STEPS.at(-1)?.script).toBe('test:release-live');
    const defined = Object.keys((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts);
    expect(scripts.filter((script) => !defined.includes(script))).toEqual([]);
  });
});

describe('a hotfix', () => {
  const hotfix = { ...shipped, hotfix: true as const };

  it('reaches main and is tagged like any release, on a record that says it skipped the gates', () => {
    expect(pushRefusal('refs/heads/main', { record: { commit: 'a', shipped: hotfix }, onlyLedgerSinceParent: false })).toBeUndefined();
    expect(pushRefusal('refs/tags/v2026.10.24-2', { record: { commit: 'a', shipped: hotfix, released: { ...released('v2026.10.24-2'), hotfix: true } }, onlyLedgerSinceParent: false })).toBeUndefined();
  });

  it('says so in its tag, which the Release workflow accepts as it accepts a gated one', () => {
    const steps = [{ name: 'typecheck', script: 'typecheck', minutes: 0.4 }];
    const fixed = tagMessage('v2026.10.24-2', 'abcdef0123456789', 'v2026.10.24', steps, true);
    const gated = tagMessage('v2026.10.24', 'abcdef0123456789', 'v2026.10.23', [{ name: 'the release rehearsal', script: 'test:release-live', minutes: 60 }], false);
    expect(fixed).toBe('v2026.10.24-2\n\nHotfix released from abcdef012345 after v2026.10.24 without the gates: typecheck and the image build.');
    expect(gated).toBe('v2026.10.24\n\nShipped and released from abcdef012345 after v2026.10.23: release-live.');
    expect([fixed, gated].every((message) => TAG_SIGNATURE.test(message))).toBe(true);
    const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    expect(workflow).toContain(`grep -qE '${TAG_SIGNATURE.source}'`);
  });
});

describe('the key a release is signed with', () => {
  const key = '/home/someone/.ssh/koala-release';
  const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs4bWFkZXVwLWtleS1mb3ItYS10ZXN0LW9ubHk= someone@box\n';

  it('is one the signers file trusts, whatever its comment says', () => {
    expect(signingKeyProblem(key, publicKey, '# who signs releases\nkoala-release namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs4bWFkZXVwLWtleS1mb3ItYS10ZXN0LW9ubHk= release key\n')).toBeUndefined();
  });

  it('is refused before the suites run when it is missing or root would not trust it', () => {
    expect(signingKeyProblem(key, undefined, 'koala-release ssh-ed25519 AAAA')).toContain(`there is no release key at ${key}`);
    expect(signingKeyProblem(key, publicKey, undefined)).toContain(`is not in ${RELEASE_SIGNERS}`);
    expect(signingKeyProblem(key, publicKey, '# koala-release namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs4bWFkZXVwLWtleS1mb3ItYS10ZXN0LW9ubHk=\n')).toContain(`is not in ${RELEASE_SIGNERS}`);
  });

  it('refuses to push a tag that does not verify, and names why', () => {
    expect(unsignedTagRefusal('v2026.10.25', undefined)).toBeUndefined();
    expect(unsignedTagRefusal('v2026.10.25', 'v2026.10.25 is not signed by a key in scripts/root-node/release-signers')).toBe('root would refuse v2026.10.25: v2026.10.25 is not signed by a key in scripts/root-node/release-signers. `npm run release` signs the tag with your release key.');
  });

  it('is what the Release workflow checks the tag against', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    expect(workflow).toContain(`gpg.ssh.allowedSignersFile=${RELEASE_SIGNERS} verify-tag`);
  });
});
