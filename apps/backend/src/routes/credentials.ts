import { Router, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';
import { asyncRoute } from '../middleware/async-route.js';
import { isCloudProvider, type CloudProvider } from '../lib/types.js';
import type { CredentialService } from '../services/CredentialService.js';

/**
 * Per-user cloud provider credentials, and the Google Drive OAuth dance that backs up to one.
 *
 * ── THE FIRST ROUTER ──
 * This is the first `express.Router()` in the codebase; index.ts had 150 routes registered directly
 * on `app`. The shape here is the one the rest will follow, and three things about it are
 * deliberate:
 *
 * 1. **A factory taking its dependencies**, not a module-level router. It means a test can build
 *    one with a stub service and mount it on a bare app — see `routes/test-harness.ts`. A
 *    module-level router would have to reach for whatever `bootstrap()` happened to construct.
 * 2. **`asyncRoute` on every handler**, so a rejected promise cannot hang the request. What this
 *    replaces is eight copies of the same `try/catch` writing the same 500 by hand.
 * 3. **`requireProvider` as middleware.** The `VALID_PROVIDERS.includes()` check was written out
 *    four times, and it validated against a list that duplicated the `CloudProvider` union by hand.
 *    Both now come from `CLOUD_PROVIDERS` in lib/types.ts.
 *
 * ── ROUTE ORDER ──
 * `/:provider` is registered before `/googledrive/connect`, exactly as in index.ts. They do not
 * collide — one segment versus two — but the order is preserved rather than tidied, because
 * "obviously equivalent" is how a routing change becomes a 404 nobody can explain.
 */

export interface CredentialsRouterDeps {
  credentialService: Pick<
    CredentialService,
    'getConfiguredProviders' | 'getCredentials' | 'saveCredentials'
    | 'deleteCredentials' | 'validateCredentials' | 'testGoogleDriveConnection'
  >;
  /** Where Google should send the user back to. The API's own externally-reachable origin. */
  publicUrl: string;
  /** Where to bounce the browser afterwards. The UI's origin, which differs from the API's in dev. */
  appUrl: string;
}

/** The user `requireAuth` put on the request. Narrowed to what these handlers actually read. */
const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

/** The provider `requireProvider` validated, so a handler never re-checks it. */
const providerOf = (req: Request): CloudProvider =>
  (req as unknown as { provider: CloudProvider }).provider;

/**
 * Rejects an unknown `:provider` before any handler runs.
 *
 * 400 rather than 404 on purpose, matching what the four inline copies did: the path exists, the
 * value in it does not name anything.
 */
function requireProvider(req: Request, res: Response, next: NextFunction): void {
  const { provider } = req.params;
  if (!isCloudProvider(provider)) {
    res.status(400).json({ error: `Invalid provider: ${provider}` });
    return;
  }
  (req as unknown as { provider: CloudProvider }).provider = provider;
  next();
}

export function credentialsRouter(deps: CredentialsRouterDeps): Router {
  const { credentialService, publicUrl, appUrl } = deps;
  const router = Router();

  /** Which providers this user has configured, and whether each still works. */
  router.get('/', asyncRoute(async (req, res) => {
    const statuses = await credentialService.getConfiguredProviders(userOf(req).id);
    res.json({ providers: statuses });
  }));

  router.post('/validate/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
    // googledrive's refresh token was never typed into the form (it came from the OAuth callback)
    // so there's nothing meaningful in req.body to validate — check the stored one.
    const result = provider === 'googledrive'
      ? await credentialService.testGoogleDriveConnection(userOf(req).id)
      : await credentialService.validateCredentials(provider, req.body);
    res.json(result);
  }));

  router.get('/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
    const creds = await credentialService.getCredentials(userOf(req).id, provider);
    res.json({ provider, credentials: creds });
  }));

  router.put('/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
    await credentialService.saveCredentials(userOf(req).id, provider, req.body);
    // Read back rather than echoing the request: what comes out is masked, and the UI renders it.
    const updated = await credentialService.getCredentials(userOf(req).id, provider);
    res.json({ success: true, provider, credentials: updated });
  }));

  router.delete('/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
    await credentialService.deleteCredentials(userOf(req).id, provider);
    res.json({ success: true, provider });
  }));

  /**
   * ── GOOGLE DRIVE (backup destination) ──
   *
   * A separate OAuth dance from `/api/auth/google` (login) — the same GOOGLE_CLIENT_ID/SECRET app
   * registration can serve both, as long as this callback URL is also added under "Authorized
   * redirect URIs" in Google Cloud Console and the Drive API is enabled for that project.
   * `scripts/backup-to-drive.sh` picks these credentials up via `generate-rclone-config.ts`.
   *
   * Both routes redirect rather than returning JSON: the browser is here, not fetch.
   */
  router.get('/googledrive/connect', (_req, res) => {
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect(`${appUrl}/?driveError=missing_client_id`);
    }
    const redirectUri = encodeURIComponent(`${publicUrl}/api/credentials/googledrive/callback`);
    // access_type=offline + prompt=consent: without BOTH, Google only hands back a refresh_token on
    // a user's very first-ever consent for this app — reconnecting later (e.g. after a Disconnect)
    // would silently get an access-token-only response.
    res.redirect(
      'https://accounts.google.com/o/oauth2/v2/auth'
      + `?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code`
      + '&access_type=offline&prompt=consent'
      + `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}`,
    );
  });

  router.get('/googledrive/callback', asyncRoute(async (req, res) => {
    // Every failure below redirects with a reason rather than rendering an error: the user is in a
    // browser mid-OAuth, and a JSON body would be a dead end.
    try {
      const { code } = req.query;
      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!googleId || !googleSecret) {
        return res.redirect(`${appUrl}/?driveError=missing_client_id`);
      }

      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: googleId,
        client_secret: googleSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${publicUrl}/api/credentials/googledrive/callback`,
      });

      const refreshToken = tokenRes.data.refresh_token;
      const accessToken = tokenRes.data.access_token;
      if (!refreshToken) {
        // Happens if the user had already granted consent before and Google didn't re-issue a
        // refresh_token despite prompt=consent (rare, but possible with cached grants) — send them
        // to revoke access at myaccount.google.com/permissions and try again.
        return res.redirect(`${appUrl}/?driveError=no_refresh_token`);
      }

      const aboutRes = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const email = aboutRes.data.user?.emailAddress || '';

      await credentialService.saveCredentials(userOf(req).id, 'googledrive', { refreshToken, email });
      res.redirect(`${appUrl}/?driveConnected=1`);
    } catch (err) {
      res.redirect(`${appUrl}/?driveError=${encodeURIComponent((err as Error).message)}`);
    }
  }));

  return router;
}
