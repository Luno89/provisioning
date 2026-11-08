# Audit: InstanceService.integration.test.ts, "claims a group for one project, again for the same project, and refuses it to any other project or instance" (2026-11-08)

## What failed
Once in a full integration run (2026-11-08, not a gate run): `service.join(token)` answered "that join command has expired or was
already used" for a join token made a line earlier. The file passed alone.

## The cause
The test's clock and the database's disagreed. The test gave `InstanceService` a fixed clock, 2026-10-02T12:00Z, so a join token's
`expiresAt` (an hour later by that clock) was stored a month in the past. `instanceJoinTokens` has a TTL index on `expiresAt`
(`expireAfterSeconds: 0`), and Mongo's TTL monitor removes expired documents by its own, real clock, once a minute. When a pass of
the monitor fell between `createJoinToken` and `join`, the token was gone, and `takeJoinToken` found nothing. A full run is slower,
so the gap was wider and a pass more likely to land in it. Koala's code is right: in production the service's clock is the
database's.

The same fault was in `instances/routes/instances.integration.test.ts` ("streams each part from the pool instance to the move's own
credential"): a move token made under a fixed 2026-10-20 clock, then joined.

## How it is now built
Both tests run the service on the real clock, as the TTL monitor does, and every date they assert is worked out from that clock
(`daysFromNow`; the trial's end and start in the fixtures likewise), so a token is never stored already expired. The expiry test
still moves the service's clock past the token's hour. The assertions say the same as before.
