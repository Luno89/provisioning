# Audit: odoo-release-live.ts (2026-11-09)

## What failed
Three runs on 2026-11-09 (in ship, then twice alone) stopped at the same place: the second release, prepared in slot b right after
stage 2b deletes the project's Infisical workspace and its reader (as when Infisical is wiped), failed about ten seconds in. The
release's reason was axios's bare "Request failed with status code 404", which named neither the service nor the request. It last
passed on 2026-11-05.

## The cause
In Koala's Infisical client (`infrastructure/services/InfisicalService.ts`), two faults together:
- It recognised a workspace Infisical no longer has only by the message `Project with ID …`. The Infisical the instance chart now
  runs (v0.167.0) says `Project with <id> not found`, without "ID", so the client never saw that the workspace was gone. That
  recognition is what drops the cached id and makes the workspace again, so it never happened.
- Two calls used the cached workspace id without going through that recognition at all: adding the project's new reader to the
  workspace (`createProjectReader`), and the id handed to Infisical's operator (`workspaceIdFor`). The first is what answered 404;
  the second would have pointed the operator at a workspace that no longer exists, the app silently getting no secrets.

The suite passed on 2026-11-05 because Infisical then ran from the old dev setup, which still answered `Project with ID`; the
instance chart's Infisical, which dev uses since step 3, does not.

## How it is now built
- A gone workspace is recognised by both forms of Infisical's message (`/^Project with (ID )?\S+ not found/`), tested with the exact
  words v0.167.0 answers.
- `workspaceIdFor` checks the cached workspace still exists before handing it out, and `createProjectReader` adds the reader through
  the same path, so both find or make the workspace again when Infisical lost it, as reading and writing secrets already did.
- Every error from Infisical now names the request it refused and what Infisical said (`Infisical answered 404 to POST
  /api/v2/workspace/…/identity-memberships/…: Project with … not found`). That message is what found the first fault; before, the
  release card showed only a status code.
- Proved: the suite passed whole on 2026-11-09 after the fix (both releases, the vault brought back, browser tests, cut-over,
  rollback and deletion), and the unit tests for each fault were seen failing on the old client.

## Found on the way
- A message from an outside service that Koala matches by its words breaks silently when that service changes its wording. The
  Infisical client was the case here; matching on status and structured fields where a service gives them is the safer pattern.
