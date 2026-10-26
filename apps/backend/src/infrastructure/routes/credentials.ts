import { Router, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';
import {
  asyncRoute, carriedByOAuthState, isCloudProvider, newOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_SECONDS, parseCookie, type CloudProvider, type SecretKey,
} from '../../platform/index.js';
import type { CredentialService } from '../services/CredentialService.js';

export interface CredentialsRouterDeps {
  credentialService: Pick<
    CredentialService,
    'getConfiguredProviders' | 'getCredentials' | 'saveCredentials'
    | 'deleteCredentials' | 'validateCredentials' | 'testGoogleDriveConnection'
  >;
  publicUrl: string;
  appUrl: string;
  sessionKey: SecretKey;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const providerOf = (req: Request): CloudProvider =>
  (req as unknown as { provider: CloudProvider }).provider;

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

  router.get('/', asyncRoute(async (req, res) => {
    const statuses = await credentialService.getConfiguredProviders(userOf(req).id);
    res.json({ providers: statuses });
  }));

  router.post('/validate/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
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
    const updated = await credentialService.getCredentials(userOf(req).id, provider);
    res.json({ success: true, provider, credentials: updated });
  }));

  router.delete('/:provider', requireProvider, asyncRoute(async (req, res) => {
    const provider = providerOf(req);
    await credentialService.deleteCredentials(userOf(req).id, provider);
    res.json({ success: true, provider });
  }));

  const stateCookie = { httpOnly: true, secure: publicUrl.startsWith('https://'), sameSite: 'lax' as const };

  router.get('/googledrive/connect', (req, res) => {
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect(`${appUrl}/?driveError=missing_client_id#/settings`);
    }
    const redirectUri = encodeURIComponent(`${publicUrl}/api/credentials/googledrive/callback`);
    const { state: started, cookie } = newOAuthState(userOf(req).id, deps.sessionKey);
    res.cookie(OAUTH_STATE_COOKIE, cookie, { ...stateCookie, maxAge: OAUTH_STATE_SECONDS * 1000 });
    res.redirect(
      'https://accounts.google.com/o/oauth2/v2/auth'
      + `?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code`
      + '&access_type=offline&prompt=consent'
      + `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}`
      + `&state=${encodeURIComponent(started)}`,
    );
  });

  router.get('/googledrive/callback', asyncRoute(async (req, res) => {
    try {
      const { code } = req.query;
      const held = carriedByOAuthState(parseCookie(req.headers.cookie, OAUTH_STATE_COOKIE), req.query.state, deps.sessionKey);
      res.clearCookie(OAUTH_STATE_COOKIE, stateCookie);
      if (!held || held.carried !== userOf(req).id) return res.redirect(`${appUrl}/?driveError=not_started_here#/settings`);
      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!googleId || !googleSecret) {
        return res.redirect(`${appUrl}/?driveError=missing_client_id#/settings`);
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
        return res.redirect(`${appUrl}/?driveError=no_refresh_token#/settings`);
      }

      const aboutRes = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const email = aboutRes.data.user?.emailAddress || '';

      await credentialService.saveCredentials(userOf(req).id, 'googledrive', { refreshToken, email });
      res.redirect(`${appUrl}/?driveConnected=1#/settings`);
    } catch (err) {
      res.redirect(`${appUrl}/?driveError=${encodeURIComponent((err as Error).message)}#/settings`);
    }
  }));

  return router;
}
