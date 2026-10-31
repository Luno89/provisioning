# Running Koala's root

What to do, in order, for each job an operator has on the root node. Root's checkout lives at `/opt/nowrinkles`; every
command below runs there, as root, unless it says otherwise. Where something is not built yet, this says so.

Domains: root itself is `app.nowrinkles.dev` (and `mesh.nowrinkles.dev` for the mesh), DNS at Cloudflare; people's
instances and apps live under `nowrinkles.app`, DNS at Porkbun. Mail goes out as `alerts@nowrinkles.dev`.

## 1. Buying and bootstrapping root

Root is bought from Koala itself, on the dev box (plan `project-to-vps.md`, Step 1; the purchase and the Porkbun DNS
provider are on branches being merged):

1. Settings → Cloud providers: add the OVHcloud keys (application key, secret, consumer key, the subsidiary) and the DNS
   credentials for each zone (a Cloudflare token for `nowrinkles.dev`; Porkbun's API key and secret for
   `nowrinkles.app`, with API Access switched on for that domain in Porkbun's dashboard).
2. Before paying anything, `npm run ovh:quote -- --plan <plan code> --datacenter <dc>` prices a cart and deletes it.
   Prove issuance too: `npm run dns:issue-check -- nowrinkles.app nowrinkles.dev` gets a wildcard certificate for
   `*.koala-check.<zone>` from Let's Encrypt's staging service through root's own Caddy and each zone's stored DNS
   credentials, then checks the temporary `_acme-challenge` records are gone and nothing else in the zone changed. Every
   zone must say ✓ issued; a refusal names what to change (Porkbun's API Access on the domain, the Cloudflare token's zones).
3. Infrastructure → Clusters → **Host Koala on a server**: pick the plan and datacenter, the two domains and an email,
   **Price it**, read the card, tick the box, **Buy**. Nothing is charged before Buy.
4. Koala follows the order. A first order on a new OVHcloud account can wait 24–48 hours for OVHcloud's identity check;
   the page says so. Then it reinstalls the server with its own SSH key, makes the DNS records, waits for a signed
   release, runs `scripts/root-node/bootstrap.sh`, starts root and shows the setup code **once**. Then it sets the
   reverse DNS (PTR) of the server's IPv4 to `mail.nowrinkles.dev` through OVHcloud's IP API (the consumer key needs
   `POST /ip/*`), waiting until OVHcloud sees that name point at the server, and runs root's mail check on the server:
   forward and reverse DNS, outbound port 25, and Spamhaus ZEN, Barracuda and UCEPROTECT level 1 asked through root's
   own resolver. The order page shows both. If OVHcloud refuses the PTR, the page says why and what to set by hand.
   IPv6 gets no PTR: root's mail server sends over IPv4 only.
5. Sign up at `https://app.nowrinkles.dev` with the setup code in the invite field. That account is the operator.
6. Run the smoke test from the dev box: `npm run test:root-smoke -- nowrinkles.dev nowrinkles.app` (add `--ssh-public`
   while SSH is still open to the internet). Every line must be ✓. It scans every port Kubernetes hands out as a
   NodePort (30000–32767) besides the common ones, over IPv6 too when `app.` has an AAAA record, and checks the PTR and
   the blocklists from where you run it.
7. Before relying on root's email, open root's admin page at `https://app.nowrinkles.dev/#/mail` and **Check now**:
   every line should be ✓. A `?` means a list could not be asked from root (Spamhaus refuses public resolvers); a `!`
   on a blocklist names where to ask for removal.
8. Close SSH to the internet: on your own computer join the mesh as an admin machine
   (`sudo bash scripts/root-node/admin-machine.sh` on root prints the command), then on root
   `sudo bash scripts/root-node/ssh-over-mesh.sh`. From then on SSH answers only over the mesh; the OVHcloud KVM console is
   the way in when the mesh is down (`ssh-over-mesh.sh --public` opens 22 again).
9. Once root works, let it follow releases: `systemctl start koala-release-watch.timer`.

Bootstrapping by hand instead (a VPS bought another way): see the header of `scripts/root-node/bootstrap.sh`; it prints
the same next steps when it ends.

### What to keep offline

Losing these loses data that no backup can bring back. Copy each into a password manager the day root is made, and again
whenever it changes. They live in `/opt/nowrinkles/apps/backend/.env` unless noted.

| Secret | Why it matters |
|---|---|
| `SESSION_KEY` | signs every session; losing it signs everyone out |
| `DATA_KEY` | encrypts every stored credential and sealed field; **losing it loses all of them** |
| `PAYLOAD_KEY` | encrypts Temporal's payloads; losing it strands running workflows |
| `EGRESS_KEY` | derives the egress proxy's passwords |
| `TEMPORAL_KEY` | derives the key every process signs its Temporal token with |
| `ROOT_IDENTITY_KEY` | root's Ed25519 identity; every instance trusts its public half |
| `BACKUP_PASSWORD` | restic's encryption password; **without it no backup can be read** |
| The release signing key | `~/.ssh/koala-release` on the dev box, not on root; root trusts only `/etc/koala/release-signers` |

Putting one back: write the line into `apps/backend/.env` as it was, `systemctl restart nowrinkles nowrinkles-workers`.

## 2. What runs on its own

- **Backups**: `koala-backup.timer`, nightly at 03:30, runs `scripts/root-node/backup.sh` (restic, encrypted, to
  `BACKUP_REPOSITORY`). `koala-backup-check.timer` runs `backup.sh check` every Sunday. Both are on only once
  `BACKUP_REPOSITORY` is set. See them: `systemctl list-timers 'koala-*'`, `journalctl -u koala-backup -n 50`.
- **Releases**: `koala-release-watch.timer`, hourly once started, runs `scripts/root-node/release-watch.sh`: it finds
  GitHub's newest published release and, when newer than root's, runs `update.sh` with it.
- **Root's services**: `nowrinkles.service` (the backend) and `nowrinkles-workers.service` (the workers).
  `journalctl -u nowrinkles -n 200`, `journalctl -u nowrinkles-workers -n 200`.
- **Watching instances**: root probes every instance and emails its owner after 10 minutes unreachable (on the branch
  being merged; see section 6).

## 3. Releasing and moving root onto a release

On the dev box: `npm run release:check` (every release step, in rounds), then `npm run ship`, push `main`, then
`npm run release`. It signs the tag, pushes it, waits for GitHub's Release workflow and checks the published image.

Root then moves at its next hourly look, or now: `bash scripts/root-node/release-watch.sh <tag>` on root, or
`ROOT_SSH=<user@host> npm run release` from the dev box. Root refuses a tag not signed by a key in
`/etc/koala/release-signers`, and refuses while a workflow is working, an activity or a workflow task in flight (wait, or add `--force`, which costs each one a retry); one waiting on a timer or a person, such as the daily dependency check or a trial, does not hold it up.
`update.sh` builds and checks everything before restarting, and goes back to the previous commit by itself if the
backend does not come back.

## 4. Rolling root back

`bash scripts/root-node/update.sh <the tag it ran before>` (add `--force` if a workflow is working). It is a full update in
reverse, through the same checks. What a rollback does to people's instances: the release root left is **withdrawn**.
Instances on automatic updates move back to root's release at their next check-in; nobody is offered the withdrawn
one again; an owner who picked it by hand keeps it and is emailed once. Disk snapshots are **not** a rollback: they
take Mongo, Temporal and Headscale back too.

## 5. Restoring root from backup

On a freshly bootstrapped root (bootstrap first, then restore):

1. Put `BACKUP_REPOSITORY`, `BACKUP_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in `apps/backend/.env`,
   and the platform keys and `ROOT_IDENTITY_KEY` from your offline copy.
2. `restic snapshots` to see what there is (with the same four values exported), then
   `bash scripts/root-node/restore.sh latest` (or a snapshot id).
3. It restores Mongo, Temporal's databases, Headscale (with its noise key, so the mesh keeps every machine), Caddy's
   data, the mail key and the data folder, and starts everything. Point DNS at the new address if it changed.
4. `npm run test:root-smoke -- nowrinkles.dev nowrinkles.app` from the dev box.

The drill: `npm run test:restore-live` proves this on two VMs before every release (about 12 minutes). Run it by hand
against the real bucket once before the first person, and once a quarter. Not backed up by root: each instance's own
data (it lives on the person's machine, or in their pool namespace).

## 6. Root or an instance cannot be reached

- **Root down**: you hear nothing from root itself. Instances notice: each one probes root every minute and, after 10
  minutes, shows "Root not answering" under Needs attention and pushes to its owner's devices (on the branch being
  merged). First checks: `ping app.nowrinkles.dev`; the OVHcloud control panel (is the VPS running?); SSH over the mesh;
  if that fails, the OVHcloud KVM console. On the box: `systemctl status nowrinkles nowrinkles-workers`,
  `docker ps -a`, `df -h`, then the sections below.
- **An instance down**: root emails its owner after 10 minutes, and once when it is back; root's People list says "not
  answering since …". A pool instance also emails root's operator. For a pool instance: its namespace on the pool node
  (`kubectl get pods -n pool-<name>`). For one on a person's own machine: it is theirs; the email tells them.

## 7. A secret leaked

- **A person's session or password**: they use Settings → Signed in elsewhere → sign out everywhere, and change the
  password; both end every other session at once, on their instance too.
- **`SESSION_KEY`**: put a new value in `apps/backend/.env` and restart. Every session signed with the old one is
  refused: everyone signs in again.
- **`DATA_KEY` or `PAYLOAD_KEY`**: the keyring keeps a previous key only through `JWT_SECRET`. Move the leaked value to
  `JWT_SECRET=<old value>`, put a new key in its place, restart, then `npm run keys -w apps/backend -- --apply` to
  re-encrypt Mongo and the key files (run it without `--apply` first: it reports what would move). Remove `JWT_SECRET`
  only when `--apply` reports nothing unreadable and no workflow started before the change still runs.
- **The Cloudflare or Porkbun credentials, OVHcloud keys**: revoke them at the provider, make new ones, put them back in
  root's `.env` (DNS) or Cloud providers (OVHcloud), restart Caddy: `docker compose -f docker-compose.caddy.yml up -d`.
- **The release signing key**: make a new one, replace the line in `scripts/root-node/release-signers` and
  `/etc/koala/release-signers` on root by hand (root never takes it from the checkout), and release again.
- **`METRICS_TOKEN`**: change it in `.env`, restart.

## 8. When something breaks on the box

- **Disk full**: `df -h`; `docker system df`; `journalctl --vacuum-size=500M`; old images `docker image prune -a` (the
  registry keeps what instances pull). A full disk stops Mongo first.
- **Temporal unhealthy**: `docker compose -f docker-compose.temporal.yml ps`, then `… logs --tail 200 temporal`. Its
  operator CLI only works from inside: `docker exec <temporal container> temporal operator cluster health --address 127.0.0.1:7236`.
  After a restore, `bash scripts/temporal-keys.sh` gives Temporal its TLS key back.
- **Caddy not getting a certificate**: `tail -200 /var/log/koala-caddy/caddy.log`. Let's Encrypt allows 5 certificates
  per exact name per week; a loop of failed issues hits it and the log names the time it lifts. Wildcards are proved
  through the zone's DNS provider: check its credential is in root's `.env` and still valid.
- **Mail not arriving**: root's admin page, `#/mail`, **Check now**, then the smoke test's mail, reverse DNS and
  blocklist lines. The PTR of the server's IPv4 must be `mail.nowrinkles.dev` (the order sets it; by hand it is the
  address's "Modify the reverse path" in OVHcloud's control panel, which OVHcloud accepts only once that name resolves
  to the address). Send yourself a test from Settings → Notifications and read the received headers for `spf=pass` and
  `dkim=pass`; once real mail passes both, DMARC can go from `p=none` to `p=quarantine`. If OVHcloud blocks port 25, set
  `MAIL_RELAYHOST` (see `docker-compose.mail.yml`).
- **A node port answering from outside**: kube-proxy's rules run before ufw's, so root's k3s must keep
  `/etc/rancher/k3s/config.yaml.d/koala-node-ports.yaml` (node ports only on 127.0.0.1 and the mesh).
  `scripts/root-node/harden-host.sh` writes it back and restarts k3s; `update.sh` runs it on every release.
- **Logs**: `journalctl -u nowrinkles -f`, `journalctl -u nowrinkles-workers -f`, `docker logs nowrinkles-caddy`,
  `docker logs provisioning-headscale`.

## 9. People

Remove an account: Settings → People on root (the operator), or the person themselves from Settings. Invites: Settings
→ Invites. An account being removed is signed out at once, everywhere.
